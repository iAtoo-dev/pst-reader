/**
 * fix-bodies.js — Backfill missing email bodies from RTF
 *
 * Many PST emails are stored as PR_RTF_COMPRESSED only (no PR_BODY / PR_BODY_HTML).
 * This script re-traverses PST files and fills in body_text for emails where both
 * body_text and body_html are currently empty, using msg.bodyRTF stripped to plain text.
 *
 * Usage:
 *   node scripts/fix-bodies.js
 *
 * Environment variables:
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
  if (
    src instanceof Buffer || src instanceof Uint8Array &&
    dest instanceof Buffer || dest instanceof Uint8Array
  ) {
    try {
      dest.set(src.subarray(srcPos, srcPos + length), destPos)
      return
    } catch { /* fall through */ }
  }
  return origArraycopy.call(this, src, srcPos, dest, destPos, length)
}

// ── SQLite setup ───────────────────────────────────────────────────────────────

const db = new Database(DB_PATH)
db.pragma('journal_mode = WAL')
db.pragma('synchronous = NORMAL')
db.pragma('temp_store = MEMORY')
db.pragma('mmap_size = 268435456')

// Verify schema has needed columns
const hasBodyText = db.prepare(`SELECT COUNT(*) as n FROM pragma_table_info('emails') WHERE name='body_text'`).get()
if (!hasBodyText || hasBodyText.n === 0) {
  console.error('ERROR: emails table missing body_text column — run extract.js first')
  process.exit(1)
}

const stmtFindEmail = db.prepare(`
  SELECT e.id, e.body_text, e.body_html
  FROM emails e
  JOIN folders f ON f.id = e.folder_id
  WHERE e.pst_source = ?
    AND f.canonical_path = ?
    AND e.subject = ?
    AND e.sender_email = ?
    AND e.body_text = ''
    AND e.body_html = ''
  LIMIT 1
`)

const stmtUpdateBody = db.prepare(`
  UPDATE emails SET body_text = ? WHERE id = ?
`)

// FTS update: delete old entry then re-insert
const stmtFtsDelete = db.prepare(`
  INSERT INTO emails_fts(emails_fts, rowid, subject, sender_name, sender_email, recipients, body_text)
  VALUES('delete', ?, '', '', '', '', '')
`)
const stmtFtsInsert = db.prepare(`
  INSERT INTO emails_fts(rowid, subject, sender_name, sender_email, recipients, body_text)
  SELECT id, subject, sender_name, sender_email, recipients, body_text
  FROM emails WHERE id = ?
`)

// ── RTF → plain text stripper ─────────────────────────────────────────────────

function stripRtf(rtf) {
  if (!rtf || typeof rtf !== 'string') return ''
  let text = rtf

  // Remove RTF hex-encoded characters like \'e9 (decode to space — good enough)
  text = text.replace(/\\'[0-9a-fA-F]{2}/g, ' ')

  // Remove \pard, \par, \tab etc. — replace \par with newline for readability
  text = text.replace(/\\par\b/g, '\n')
  text = text.replace(/\\tab\b/g, '\t')
  text = text.replace(/\\line\b/g, '\n')

  // Remove all other control words and symbols
  text = text.replace(/\\[a-zA-Z]+\*?-?[0-9]*/g, ' ')
  text = text.replace(/\\\*/g, '')
  text = text.replace(/\\[{}\\]/g, '')

  // Remove group delimiters
  text = text.replace(/[{}]/g, '')

  // Clean up remaining backslashes and excess whitespace
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
  .filter(f => f.toLowerCase().endsWith('.pst') || f.toLowerCase().endsWith('.ost'))
  .map(f => join(PST_DIR, f))
  .filter(f => { try { return statSync(f).isFile() } catch { return false } })

if (pstFiles.length === 0) {
  console.error(`No PST/OST files found in ${PST_DIR}`)
  process.exit(1)
}

console.log(`Found ${pstFiles.length} PST file(s)\n`)

// ── Stats ─────────────────────────────────────────────────────────────────────

const stats = { scanned: 0, updated: 0, skipped: 0 }

// ── Folder traversal ──────────────────────────────────────────────────────────

function processFolder(folder, rawPath, pstSource) {
  const folderName = folder.displayName || 'Unknown'
  const fullRawPath = rawPath ? `${rawPath} / ${folderName}` : folderName
  const canonPath = canonicalizePath(fullRawPath)

  const emailCount = folder.contentCount || 0

  if (emailCount > 0) {
    // Check if this folder has any empty-body emails before traversing
    const emptyCount = db.prepare(`
      SELECT COUNT(*) as n
      FROM emails e
      JOIN folders f ON f.id = e.folder_id
      WHERE e.pst_source = ? AND f.canonical_path = ?
        AND e.body_text = '' AND e.body_html = ''
    `).get(pstSource, canonPath)

    if (!emptyCount || emptyCount.n === 0) {
      // Nothing to fix in this folder, but still recurse into sub-folders
    } else {
      process.stdout.write(`  ${fullRawPath} (${emptyCount.n} empty) ... `)
      let folderUpdated = 0

      try {
        folder.moveChildCursorTo(0)
      } catch { /* skip */ }

      const batchUpdate = db.transaction(() => {
        // eslint-disable-next-line no-constant-condition
        while (true) {
          let msg
          try {
            msg = folder.getNextChild()
          } catch { break }
          if (msg === null) break
          if (!(msg instanceof PSTMessage)) continue

          stats.scanned++

          const subject    = msg.subject || ''
          const senderEmail = msg.senderEmailAddress || ''

          // Quick check: skip if this message likely has body_text already
          // (we rely on the stmtFindEmail query for the definitive check)
          let bodyText = ''
          try { bodyText = msg.body || '' } catch { /* skip */ }
          let bodyHTML = ''
          try { bodyHTML = msg.bodyHTML || '' } catch { /* skip */ }

          if (bodyText || bodyHTML) {
            stats.skipped++
            continue  // has content, skip
          }

          // Try RTF
          let rtf = ''
          try { rtf = msg.bodyRTF || '' } catch { /* skip */ }

          if (!rtf) {
            stats.skipped++
            continue
          }

          const stripped = stripRtf(rtf)
          if (!stripped || stripped.length < 10) {
            stats.skipped++
            continue
          }

          // Find matching empty-body email in DB
          const row = stmtFindEmail.get(pstSource, canonPath, subject, senderEmail)
          if (!row) {
            stats.skipped++
            continue
          }

          stmtUpdateBody.run(stripped, row.id)
          try {
            stmtFtsDelete.run(row.id)
            stmtFtsInsert.run(row.id)
          } catch { /* FTS errors are non-fatal */ }

          folderUpdated++
          stats.updated++
        }
      })

      batchUpdate()
      console.log(`✓ ${folderUpdated} updated`)
    }
  }

  // Recurse into sub-folders
  try {
    const subFolders = folder.getSubFolders()
    for (const sub of subFolders) {
      processFolder(sub, fullRawPath, pstSource)
    }
  } catch { /* skip */ }
}

// ── Main loop ─────────────────────────────────────────────────────────────────

for (const filePath of pstFiles) {
  const pstSource = basename(filePath)
  const sizeMB = (statSync(filePath).size / 1024 / 1024).toFixed(1)
  console.log(`Processing: ${pstSource} (${sizeMB} MB)`)

  let pstFile
  try {
    pstFile = new PSTFile(filePath)
  } catch (e) {
    console.log(`  Error opening ${pstSource}: ${e.message}`)
    continue
  }

  try {
    const rootFolder = pstFile.getRootFolder()
    const subFolders = rootFolder.getSubFolders()
    for (const folder of subFolders) {
      processFolder(folder, '', pstSource)
    }
  } catch (e) {
    console.log(`  Error processing ${pstSource}: ${e.message}`)
  } finally {
    try { pstFile.close() } catch { /* ignore */ }
  }
}

// ── FTS optimize ──────────────────────────────────────────────────────────────

if (stats.updated > 0) {
  console.log('\nOptimizing FTS index...')
  try {
    db.prepare(`INSERT INTO emails_fts(emails_fts) VALUES('optimize')`).run()
  } catch { /* ignore */ }
}

console.log(`\nDone!`)
console.log(`  Scanned:  ${stats.scanned} emails`)
console.log(`  Updated:  ${stats.updated} emails`)
console.log(`  Skipped:  ${stats.skipped} (already had body or no RTF)`)
console.log()
