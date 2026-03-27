/**
 * fix-bodies.js — Backfill missing email bodies from RTF
 *
 * 5000+ emails have empty body_text AND body_html because they are stored
 * as PR_RTF_COMPRESSED only. This script re-traverses PST files, reads
 * bodyRTF and strips it to plain text, then updates the DB in-place.
 *
 * Strategy:
 *   1. Pre-load all email IDs that need fixing into a lookup Map
 *   2. Traverse PST files; for each empty-body message, look it up and update
 *
 * Usage:
 *   node scripts/fix-bodies.js
 *
 * Env vars:
 *   PST_DIR   Directory containing .pst files (default: ./pst-files)
 *   DB_PATH   Path to the SQLite archive DB   (default: ./archive.db)
 */

import { createRequire } from 'module'
import { readdirSync, statSync } from 'fs'
import { join, basename, resolve } from 'path'
import { fileURLToPath } from 'url'

const __dirname = fileURLToPath(new URL('.', import.meta.url))

const requireRoot   = createRequire(resolve(__dirname, '../node_modules/'))
const requireViewer = createRequire(resolve(__dirname, '../pst-viewer/node_modules/'))

const Database  = requireRoot('better-sqlite3')
const { PSTFile, PSTFolder, PSTMessage } = requireViewer('pst-extractor')
const { PSTUtil } = requireViewer('pst-extractor/dist/PSTUtil.class')

// ── Config ─────────────────────────────────────────────────────────────────────

const PST_DIR = resolve(process.env.PST_DIR || join(__dirname, '..', 'pst-files'))
const DB_PATH = resolve(process.env.DB_PATH || join(__dirname, '..', 'archive.db'))

console.log(`\nPST Body Backfill`)
console.log(`  PST dir: ${PST_DIR}`)
console.log(`  DB path: ${DB_PATH}`)
console.log()

// ── PSTUtil performance patch ──────────────────────────────────────────────────

const origArraycopy = PSTUtil.arraycopy
PSTUtil.arraycopy = function(src, srcPos, dest, destPos, length) {
  if (src && dest && typeof src.set === 'function' && typeof src.subarray === 'function') {
    try { dest.set(src.subarray(srcPos, srcPos + length), destPos); return } catch { /* fall through */ }
  }
  return origArraycopy.call(this, src, srcPos, dest, destPos, length)
}

// ── SQLite ─────────────────────────────────────────────────────────────────────

const db = new Database(DB_PATH)
db.pragma('journal_mode = WAL')
db.pragma('synchronous = NORMAL')
db.pragma('temp_store = MEMORY')
db.pragma('mmap_size = 268435456')

// ── Step 1: pre-load all emails that need fixing ───────────────────────────────
//
// Key: "pst_source|canonical_path|subject|sender_email"
// Value: array of { id } (there could be duplicates with same key)

console.log('Loading emails that need body fix from DB...')

const needsFix = new Map()   // key → [ { id, used: false }, ... ]
let totalNeedFix = 0

const rows = db.prepare(`
  SELECT e.id, e.pst_source, e.subject, e.sender_email, f.canonical_path
  FROM emails e
  JOIN folders f ON f.id = e.folder_id
  WHERE e.body_text = '' AND e.body_html = ''
  ORDER BY e.id
`).all()

for (const row of rows) {
  const key = `${row.pst_source}|${row.canonical_path}|${row.subject}|${row.sender_email}`
  if (!needsFix.has(key)) needsFix.set(key, [])
  needsFix.get(key).push({ id: row.id, used: false })
  totalNeedFix++
}

console.log(`  Found ${totalNeedFix} emails needing body fix\n`)

if (totalNeedFix === 0) {
  console.log('Nothing to do.')
  process.exit(0)
}

// Also print pst_source distribution to help debug
const srcDist = db.prepare(`
  SELECT e.pst_source, COUNT(*) as n
  FROM emails e
  WHERE e.body_text = '' AND e.body_html = ''
  GROUP BY e.pst_source
  ORDER BY n DESC
`).all()
console.log('  Distribution by PST source:')
for (const r of srcDist) console.log(`    ${r.pst_source}: ${r.n} emails`)
console.log()

// ── Prepared statements ────────────────────────────────────────────────────────

const stmtUpdateBody = db.prepare(`UPDATE emails SET body_text = ? WHERE id = ?`)
const stmtFtsDelete  = db.prepare(`
  INSERT INTO emails_fts(emails_fts, rowid, subject, sender_name, sender_email, recipients, body_text)
  VALUES('delete', ?, '', '', '', '', '')
`)
const stmtFtsInsert  = db.prepare(`
  INSERT INTO emails_fts(rowid, subject, sender_name, sender_email, recipients, body_text)
  SELECT id, subject, sender_name, sender_email, recipients, body_text
  FROM emails WHERE id = ?
`)

// ── RTF → plain text ──────────────────────────────────────────────────────────

function stripRtf(rtf) {
  if (!rtf || typeof rtf !== 'string') return ''
  let text = rtf
  text = text.replace(/\\'[0-9a-fA-F]{2}/g, ' ')      // hex-encoded chars
  text = text.replace(/\\par\b/g, '\n')                 // paragraph break
  text = text.replace(/\\tab\b/g, '\t')                 // tab
  text = text.replace(/\\line\b/g, '\n')                // line break
  text = text.replace(/\\[a-zA-Z]+\*?-?[0-9]*/g, ' ')  // control words
  text = text.replace(/\\\*/g, '')
  text = text.replace(/\\[{}\\]/g, '')
  text = text.replace(/[{}]/g, '')
  text = text.replace(/\\/g, ' ')
  text = text.replace(/[ \t]+/g, ' ')
  text = text.replace(/\n[ \t]+/g, '\n')
  text = text.replace(/\n{3,}/g, '\n\n')
  return text.trim()
}

// ── Canonical path ─────────────────────────────────────────────────────────────

function canonicalizePath(rawPath) {
  const parts = rawPath.split(' / ')
  return ['Mailbox', ...parts.slice(1)].join(' / ')
}

// ── PST files ─────────────────────────────────────────────────────────────────

const pstFiles = readdirSync(PST_DIR)
  .filter(f => /\.(pst|ost)$/i.test(f))
  .map(f => join(PST_DIR, f))
  .filter(f => { try { return statSync(f).isFile() } catch { return false } })

if (pstFiles.length === 0) {
  console.error(`No PST/OST files found in ${PST_DIR}`)
  process.exit(1)
}

console.log(`Processing ${pstFiles.length} PST file(s)...\n`)

// ── Stats ─────────────────────────────────────────────────────────────────────

const stats = { scanned: 0, updated: 0, noRTF: 0, noMatch: 0 }

// ── Folder traversal ──────────────────────────────────────────────────────────

function processFolder(folder, rawPath, pstSource) {
  const folderName = folder.displayName || 'Unknown'
  const fullRawPath = rawPath ? `${rawPath} / ${folderName}` : folderName
  const canonPath   = canonicalizePath(fullRawPath)

  const emailCount = folder.contentCount || 0

  if (emailCount > 0) {
    try { folder.moveChildCursorTo(0) } catch { /* skip */ }

    const batchUpdate = db.transaction(() => {
      let folderUpdated = 0

      // eslint-disable-next-line no-constant-condition
      while (true) {
        let msg
        try { msg = folder.getNextChild() } catch { break }
        if (msg === null) break
        if (!(msg instanceof PSTMessage)) continue

        stats.scanned++

        // Skip emails that already have a body in the PST
        let bodyText = ''
        try { bodyText = msg.body || '' } catch { /* skip */ }
        if (bodyText) continue

        let bodyHTML = ''
        try { bodyHTML = msg.bodyHTML || '' } catch { /* skip */ }
        if (bodyHTML) continue

        // This email has no plain text or HTML body → try RTF
        let rtf = ''
        try { rtf = msg.bodyRTF || '' } catch { /* skip */ }

        const subject     = msg.subject || ''
        const senderEmail = msg.senderEmailAddress || ''

        // Look up in the pre-loaded Map
        const key = `${pstSource}|${canonPath}|${subject}|${senderEmail}`
        const candidates = needsFix.get(key)
        const candidate  = candidates?.find(c => !c.used)

        if (!candidate) {
          stats.noMatch++
          continue
        }

        if (!rtf) {
          stats.noRTF++
          // Mark as used anyway so we don't keep trying
          candidate.used = true
          continue
        }

        const stripped = stripRtf(rtf)
        if (!stripped || stripped.length < 5) {
          stats.noRTF++
          candidate.used = true
          continue
        }

        stmtUpdateBody.run(stripped, candidate.id)
        try {
          stmtFtsDelete.run(candidate.id)
          stmtFtsInsert.run(candidate.id)
        } catch { /* FTS errors are non-fatal */ }

        candidate.used = true
        folderUpdated++
        stats.updated++
      }

      if (folderUpdated > 0) {
        console.log(`  ${fullRawPath}: +${folderUpdated} updated`)
      }
    })

    batchUpdate()
  }

  // Recurse into sub-folders
  try {
    const subFolders = folder.getSubFolders()
    for (const sub of subFolders) {
      processFolder(sub, fullRawPath, pstSource)
    }
  } catch { /* skip problematic folders */ }
}

// ── Main loop ─────────────────────────────────────────────────────────────────

for (const filePath of pstFiles) {
  const pstSource = basename(filePath)
  const sizeMB    = (statSync(filePath).size / 1024 / 1024).toFixed(1)
  console.log(`Processing: ${pstSource} (${sizeMB} MB)`)

  let pstFile
  try {
    pstFile = new PSTFile(filePath)
  } catch (e) {
    console.log(`  Error opening: ${e.message}`)
    continue
  }

  try {
    const rootFolder = pstFile.getRootFolder()
    for (const folder of rootFolder.getSubFolders()) {
      processFolder(folder, '', pstSource)
    }
  } catch (e) {
    console.log(`  Error: ${e.message}`)
  } finally {
    try { pstFile.close() } catch { /* ignore */ }
  }
}

// ── FTS optimize ──────────────────────────────────────────────────────────────

if (stats.updated > 0) {
  console.log('\nOptimizing FTS index...')
  try { db.prepare(`INSERT INTO emails_fts(emails_fts) VALUES('optimize')`).run() } catch { /* ignore */ }
}

// ── Summary ───────────────────────────────────────────────────────────────────

const unmatched = totalNeedFix - stats.updated - stats.noRTF
console.log(`
Done!
  Total to fix:  ${totalNeedFix}
  Updated:       ${stats.updated}   (body_text filled with stripped RTF)
  No RTF found:  ${stats.noRTF}     (no body available in any format)
  No PST match:  ${stats.noMatch}   (email in DB but not found in PST traversal)
  Unaccounted:   ${unmatched}
`)
