/**
 * PST → SQLite extraction script
 *
 * Usage:
 *   node scripts/extract.js
 *
 * Environment variables:
 *   PST_DIR   Directory containing .pst files (default: ./pst-files)
 *   DB_PATH   Path for output SQLite database (default: ./archive.db)
 */

import { createRequire } from 'module'
import { readdirSync, statSync } from 'fs'
import { join, basename, resolve } from 'path'
import { fileURLToPath } from 'url'

const __dirname = fileURLToPath(new URL('.', import.meta.url))

// Use createRequire to load CJS modules
const requireRoot = createRequire(resolve(__dirname, '../node_modules/'))
const requireViewer = createRequire(resolve(__dirname, '../pst-viewer/node_modules/'))

const Database = requireRoot('better-sqlite3')
const {
  PSTFile,
  PSTFolder,
  PSTMessage,
  PSTAppointment,
  PSTTask,
  PSTContact,
} = requireViewer('pst-extractor')
const { PSTUtil } = requireViewer('pst-extractor/dist/PSTUtil.class')

// ── Configuration ─────────────────────────────────────────────────────────────

const PST_DIR = resolve(process.env.PST_DIR || join(__dirname, '..', 'pst-files'))
const DB_PATH = resolve(process.env.DB_PATH || join(__dirname, '..', 'archive.db'))

// ── SQLite setup ──────────────────────────────────────────────────────────────

console.log(`\nPST → SQLite Extractor`)
console.log(`  PST dir: ${PST_DIR}`)
console.log(`  DB path: ${DB_PATH}`)
console.log()

const db = new Database(DB_PATH)
db.pragma('journal_mode = WAL')
db.pragma('synchronous = NORMAL')
db.pragma('temp_store = MEMORY')
db.pragma('mmap_size = 268435456')

db.exec(`
CREATE TABLE IF NOT EXISTS folders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pst_source TEXT NOT NULL,
  path TEXT NOT NULL,
  canonical_path TEXT NOT NULL,
  name TEXT NOT NULL,
  email_count INTEGER NOT NULL DEFAULT 0,
  UNIQUE(pst_source, path)
);

CREATE TABLE IF NOT EXISTS emails (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  folder_id INTEGER NOT NULL REFERENCES folders(id),
  pst_source TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  sender_name TEXT NOT NULL DEFAULT '',
  sender_email TEXT NOT NULL DEFAULT '',
  recipients TEXT NOT NULL DEFAULT '',
  recipients_cc TEXT NOT NULL DEFAULT '',
  date_sent TEXT,
  date_received TEXT,
  has_attachments INTEGER NOT NULL DEFAULT 0,
  attachment_count INTEGER NOT NULL DEFAULT 0,
  attachment_names TEXT NOT NULL DEFAULT '[]',
  body_text TEXT NOT NULL DEFAULT '',
  body_html TEXT NOT NULL DEFAULT '',
  importance INTEGER NOT NULL DEFAULT 1,
  is_read INTEGER NOT NULL DEFAULT 1,
  message_id TEXT,
  message_class TEXT NOT NULL DEFAULT 'IPM.Note',
  item_type TEXT NOT NULL DEFAULT 'email',
  location TEXT,
  start_time TEXT,
  end_time TEXT,
  task_status INTEGER,
  contact_name TEXT,
  contact_phone TEXT,
  contact_company TEXT
);

CREATE TABLE IF NOT EXISTS attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email_id INTEGER NOT NULL REFERENCES emails(id),
  filename TEXT NOT NULL DEFAULT 'attachment',
  mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  size INTEGER NOT NULL DEFAULT 0,
  data BLOB NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS emails_fts USING fts5(
  subject, sender_name, sender_email, recipients, body_text,
  content='emails', content_rowid='id',
  tokenize='unicode61'
);

CREATE TABLE IF NOT EXISTS _progress (
  pst_source TEXT NOT NULL,
  folder_path TEXT NOT NULL,
  PRIMARY KEY(pst_source, folder_path)
);

CREATE INDEX IF NOT EXISTS idx_emails_folder ON emails(folder_id);
CREATE INDEX IF NOT EXISTS idx_emails_date ON emails(date_sent DESC);
CREATE INDEX IF NOT EXISTS idx_emails_sender ON emails(sender_email);
CREATE INDEX IF NOT EXISTS idx_att_email ON attachments(email_id);
`)

// ── Prepared statements ───────────────────────────────────────────────────────

const stmtInsertFolder = db.prepare(`
  INSERT OR IGNORE INTO folders (pst_source, path, canonical_path, name, email_count)
  VALUES (@pst_source, @path, @canonical_path, @name, @email_count)
`)
const stmtGetFolder = db.prepare(`SELECT id FROM folders WHERE pst_source = ? AND path = ?`)
const stmtUpdateFolderCount = db.prepare(`UPDATE folders SET email_count = email_count + ? WHERE id = ?`)

const stmtInsertEmail = db.prepare(`
  INSERT INTO emails (
    folder_id, pst_source, subject, sender_name, sender_email,
    recipients, recipients_cc, date_sent, date_received,
    has_attachments, attachment_count, attachment_names,
    body_text, body_html, importance, is_read, message_id,
    message_class, item_type, location, start_time, end_time,
    task_status, contact_name, contact_phone, contact_company
  ) VALUES (
    @folder_id, @pst_source, @subject, @sender_name, @sender_email,
    @recipients, @recipients_cc, @date_sent, @date_received,
    @has_attachments, @attachment_count, @attachment_names,
    @body_text, @body_html, @importance, @is_read, @message_id,
    @message_class, @item_type, @location, @start_time, @end_time,
    @task_status, @contact_name, @contact_phone, @contact_company
  )
`)

const stmtInsertFts = db.prepare(`
  INSERT INTO emails_fts(rowid, subject, sender_name, sender_email, recipients, body_text)
  VALUES (?, ?, ?, ?, ?, ?)
`)

const stmtInsertAttachment = db.prepare(`
  INSERT INTO attachments (email_id, filename, mime_type, size, data)
  VALUES (@email_id, @filename, @mime_type, @size, @data)
`)

const stmtMarkProgress = db.prepare(`
  INSERT OR REPLACE INTO _progress (pst_source, folder_path) VALUES (?, ?)
`)
const stmtCheckProgress = db.prepare(`
  SELECT 1 FROM _progress WHERE pst_source = ? AND folder_path = ?
`)

// ── Helpers ───────────────────────────────────────────────────────────────────

function canonicalizePath(rawPath) {
  const parts = rawPath.split(' / ')
  return ['Mailbox', ...parts.slice(1)].join(' / ')
}

function makePstSource(filename, filesize) {
  const safeName = basename(filename).replace(/[^a-zA-Z0-9._-]/g, '_')
  return `${safeName}:${filesize}`
}

function safeDate(d) {
  if (!d) return null
  try {
    const iso = d instanceof Date ? d.toISOString() : new Date(d).toISOString()
    return iso === 'Invalid Date' ? null : iso
  } catch {
    return null
  }
}

// ── RTF → plain text ──────────────────────────────────────────────────────────

function stripRtf(rtf) {
  if (!rtf || typeof rtf !== 'string') return ''
  let text = rtf
  text = text.replace(/\\'[0-9a-fA-F]{2}/g, ' ')       // hex-encoded chars \'e9
  text = text.replace(/\\par\b/g, '\n')                  // paragraph → newline
  text = text.replace(/\\tab\b/g, '\t')                  // tab
  text = text.replace(/\\line\b/g, '\n')                 // line break
  text = text.replace(/\\[a-zA-Z]+\*?-?[0-9]*/g, ' ')   // control words
  text = text.replace(/\\\*/g, '')
  text = text.replace(/\\[{}\\]/g, '')
  text = text.replace(/[{}\\]/g, '')
  text = text.replace(/[ \t]+/g, ' ')
  text = text.replace(/\n[ \t]+/g, '\n')
  text = text.replace(/\n{3,}/g, '\n\n')
  return text.trim()
}

// ── Body extraction with RTF fallback ─────────────────────────────────────────
// Priority: HTML (richest) → plain text → RTF stripped → empty

function extractBodies(msg) {
  let body_html = ''
  let body_text = ''

  try { body_html = msg.bodyHTML || '' } catch { /* skip */ }
  try { body_text = msg.body      || '' } catch { /* skip */ }

  // If neither HTML nor plain text, try RTF compressed body
  if (!body_html && !body_text) {
    try {
      const rtf = msg.bodyRTF || ''
      if (rtf) body_text = stripRtf(rtf)
    } catch { /* skip */ }
  }

  return { body_html, body_text }
}

function detectItemType(messageClass) {
  if (!messageClass) return 'email'
  const mc = messageClass.toLowerCase()
  if (mc.startsWith('ipm.appointment') || mc.startsWith('ipm.schedule.meeting')) return 'appointment'
  if (mc.startsWith('ipm.task')) return 'task'
  if (mc.startsWith('ipm.contact') || mc.startsWith('ipm.distlist')) return 'contact'
  if (mc.startsWith('ipm.activity')) return 'activity'
  return 'email'
}

// ── Monkey-patches ────────────────────────────────────────────────────────────

// Patch PSTUtil.arraycopy for performance
const origArraycopy = PSTUtil.arraycopy
PSTUtil.arraycopy = function(src, srcPos, dest, destPos, length) {
  if (
    src instanceof Buffer || src instanceof Uint8Array &&
    dest instanceof Buffer || dest instanceof Uint8Array
  ) {
    try {
      dest.set(src.subarray(srcPos, srcPos + length), destPos)
      return
    } catch {
      // fall through
    }
  }
  return origArraycopy.call(this, src, srcPos, dest, destPos, length)
}

// ── Folder walker ─────────────────────────────────────────────────────────────

function processFolder(folder, rawPath, pstSource, stats) {
  const folderName = folder.displayName || 'Unknown'
  const fullRawPath = rawPath ? `${rawPath} / ${folderName}` : folderName
  const canonPath = canonicalizePath(fullRawPath)

  // Check if already done
  if (stmtCheckProgress.get(pstSource, fullRawPath)) {
    // Still recurse into subfolders
    try {
      const subFolders = folder.getSubFolders()
      for (const sub of subFolders) {
        processFolder(sub, fullRawPath, pstSource, stats)
      }
    } catch { /* skip */ }
    return
  }

  const emailCount = folder.contentCount || 0

  // Upsert folder
  stmtInsertFolder.run({
    pst_source: pstSource,
    path: fullRawPath,
    canonical_path: canonPath,
    name: folderName,
    email_count: 0,
  })
  const folderRow = stmtGetFolder.get(pstSource, fullRawPath)
  const folderId = folderRow ? folderRow.id : null

  if (!folderId) {
    console.log(`  Warning: could not get folder id for ${fullRawPath}`)
    return
  }

  if (emailCount > 0) {
    process.stdout.write(`  ${fullRawPath} (${emailCount}) ... `)
  }

  let n = 0
  const insertFolderBatch = db.transaction(() => {
    try {
      folder.moveChildCursorTo(0)
    } catch { return }

    // eslint-disable-next-line no-constant-condition
    while (true) {
      let msg
      try {
        msg = folder.getNextChild()
      } catch {
        break
      }
      if (!msg) break

      try {
        const messageClass = msg.messageClass || 'IPM.Note'
        const itemType = detectItemType(messageClass)

        // Recipients
        let recipients = ''
        let recipientsCc = ''
        try {
          const recips = []
          const ccs = []
          if (msg.displayTo) recips.push(msg.displayTo)
          if (msg.displayCC) ccs.push(msg.displayCC)
          recipients = recips.join('; ')
          recipientsCc = ccs.join('; ')
        } catch { /* skip */ }

        // Attachment names
        const attNames = []
        let attCount = 0
        try {
          attCount = msg.numberOfAttachments || 0
          for (let i = 0; i < attCount; i++) {
            try {
              const att = msg.getAttachment(i)
              attNames.push(att.longFilename || att.filename || `attachment_${i}`)
            } catch { /* skip */ }
          }
        } catch { /* skip */ }

        // Item-type-specific fields
        let location = null
        let startTime = null
        let endTime = null
        let taskStatus = null
        let contactName = null
        let contactPhone = null
        let contactCompany = null

        if (itemType === 'appointment') {
          try {
            const appt = msg
            location = appt.location || null
            startTime = safeDate(appt.startTime)
            endTime = safeDate(appt.endTime)
          } catch { /* skip */ }
        } else if (itemType === 'task') {
          try {
            taskStatus = msg.taskStatus ?? null
          } catch { /* skip */ }
        } else if (itemType === 'contact') {
          try {
            contactName = msg.displayName || msg.surname || null
            contactPhone = msg.primaryTelephone || msg.businessTelephone || null
            contactCompany = msg.companyName || null
          } catch { /* skip */ }
        }

        const emailRow = {
          folder_id: folderId,
          pst_source: pstSource,
          subject: msg.subject || '',
          sender_name: msg.senderName || '',
          sender_email: msg.senderEmailAddress || '',
          recipients,
          recipients_cc: recipientsCc,
          date_sent: safeDate(msg.clientSubmitTime),
          date_received: safeDate(msg.messageDeliveryTime),
          has_attachments: attCount > 0 ? 1 : 0,
          attachment_count: attCount,
          attachment_names: JSON.stringify(attNames),
          ...extractBodies(msg),
          importance: msg.importance ?? 1,
          is_read: msg.isRead ? 1 : 0,
          message_id: msg.internetMessageId || null,
          message_class: messageClass,
          item_type: itemType,
          location,
          start_time: startTime,
          end_time: endTime,
          task_status: taskStatus,
          contact_name: contactName,
          contact_phone: contactPhone,
          contact_company: contactCompany,
        }

        const result = stmtInsertEmail.run(emailRow)
        const emailId = result.lastInsertRowid

        // FTS insert
        stmtInsertFts.run(
          emailId,
          emailRow.subject,
          emailRow.sender_name,
          emailRow.sender_email,
          emailRow.recipients,
          emailRow.body_text,
        )

        // Attachments
        for (let i = 0; i < attCount; i++) {
          try {
            const att = msg.getAttachment(i)
            const stream = att.fileInputStream
            if (!stream) continue
            const size = att.filesize > 0 ? att.filesize : (att.size || 0)
            const buf = Buffer.alloc(size)
            if (size > 0) {
              stream.readCompletely(buf)
            }
            stmtInsertAttachment.run({
              email_id: emailId,
              filename: att.longFilename || att.filename || 'attachment',
              mime_type: att.mimeTag || 'application/octet-stream',
              size,
              data: buf,
            })
          } catch { /* skip broken attachments */ }
        }

        n++
      } catch (msgErr) {
        // Skip broken messages
      }
    }

    // Update folder email count
    stmtUpdateFolderCount.run(n, folderId)
    // Mark folder as done
    stmtMarkProgress.run(pstSource, fullRawPath)
  })

  insertFolderBatch()

  if (emailCount > 0) {
    process.stdout.write(`✓ ${n} emails\n`)
  }

  stats.totalEmails += n

  // Recurse into subfolders
  try {
    const subFolders = folder.getSubFolders()
    for (const sub of subFolders) {
      processFolder(sub, fullRawPath, pstSource, stats)
    }
  } catch { /* skip */ }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  let pstFiles
  try {
    pstFiles = readdirSync(PST_DIR)
      .filter(f => f.toLowerCase().endsWith('.pst'))
      .sort()
  } catch (e) {
    console.error(`Cannot read PST_DIR: ${PST_DIR}\n${e.message}`)
    process.exit(1)
  }

  if (pstFiles.length === 0) {
    console.log(`No .pst files found in ${PST_DIR}`)
    process.exit(0)
  }

  console.log(`Found ${pstFiles.length} PST file(s):`)
  for (const f of pstFiles) {
    const stat = statSync(join(PST_DIR, f))
    console.log(`  ${f} (${(stat.size / 1024 / 1024).toFixed(1)} MB)`)
  }
  console.log()

  const totalStats = { totalEmails: 0 }

  for (const filename of pstFiles) {
    const filePath = join(PST_DIR, filename)
    const fileSize = statSync(filePath).size
    const pstSource = makePstSource(filename, fileSize)

    console.log(`\nProcessing: ${filename} (${pstSource})`)

    let pstFile = null
    try {
      // Pass file path directly — PSTFile opens its own fd and reads natively
      pstFile = new PSTFile(filePath)

      const rootFolder = pstFile.getRootFolder()
      const subFolders = rootFolder.getSubFolders()

      for (const folder of subFolders) {
        processFolder(folder, '', pstSource, totalStats)
      }

    } catch (e) {
      console.error(`  Error processing ${filename}: ${e.message}`)
    } finally {
      if (pstFile !== null) {
        try { pstFile.close() } catch { /* ignore */ }
      }
    }
  }

  console.log(`\nOptimizing FTS index...`)
  db.exec("INSERT INTO emails_fts(emails_fts) VALUES('optimize')")

  console.log(`\nDone! Total emails extracted: ${totalStats.totalEmails}`)
  console.log(`Database: ${DB_PATH}`)

  db.close()
}

main().catch(e => {
  console.error('Fatal error:', e)
  process.exit(1)
})
