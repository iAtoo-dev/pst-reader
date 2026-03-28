/**
 * PST Archive Server
 *
 * Configuration via environment variables:
 *   PST_DIR      Directory containing .pst files  (default: ./pst-files)
 *   PST_PASSWORD Password for Basic Auth          (default: empty = no auth)
 *   PORT         HTTP port                        (default: 3000)
 *   FRONTEND     Path to the built frontend HTML  (default: ./pst-viewer/dist/index.html)
 *   DB_PATH      Path to the SQLite archive DB    (default: ./archive.db)
 */

import express from 'express'
import { createReadStream, statSync, existsSync } from 'fs'
import { readdir } from 'fs/promises'
import { join, extname, basename, resolve } from 'path'
import { timingSafeEqual, createHash } from 'crypto'
import { fileURLToPath } from 'url'
import { createRequire } from 'module'

const __dirname = fileURLToPath(new URL('.', import.meta.url))

const PST_DIR  = resolve(process.env.PST_DIR  || join(__dirname, 'pst-files'))
const PORT     = parseInt(process.env.PORT     || '3000', 10)
const PASSWORD = process.env.PST_PASSWORD      || ''
const FRONTEND = resolve(process.env.FRONTEND  || join(__dirname, 'pst-viewer', 'dist', 'index.html'))
const DB_PATH  = resolve(process.env.DB_PATH   || join(__dirname, 'archive.db'))

const app = express()

// ── JSON body parser (for POST /api/export) ───────────────────────────────────

app.use(express.json())

// ── Basic Auth middleware ─────────────────────────────────────────────────────

if (PASSWORD) {
  const expectedHash = createHash('sha256').update(PASSWORD).digest()

  app.use((req, res, next) => {
    const auth = req.headers['authorization'] || ''
    if (!auth.startsWith('Basic ')) {
      res.setHeader('WWW-Authenticate', 'Basic realm="PST Archive", charset="UTF-8"')
      res.status(401).send('Authentication required')
      return
    }

    let given = ''
    try {
      const decoded = Buffer.from(auth.slice(6), 'base64').toString('utf-8')
      // credentials = "username:password" — we only check the password part
      given = decoded.slice(decoded.indexOf(':') + 1)
    } catch {
      res.status(401).send('Bad credentials')
      return
    }

    const givenHash = createHash('sha256').update(given).digest()
    // Timing-safe comparison to prevent timing attacks
    if (expectedHash.length !== givenHash.length || !timingSafeEqual(expectedHash, givenHash)) {
      res.setHeader('WWW-Authenticate', 'Basic realm="PST Archive", charset="UTF-8"')
      res.status(401).send('Invalid password')
      return
    }
    next()
  })
}

// ── CORS headers (needed when frontend and API are on different ports in dev) ─

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*')
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Range')
  res.setHeader('Access-Control-Allow-Credentials', 'true')
  res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Content-Length, Accept-Ranges')
  if (req.method === 'OPTIONS') { res.sendStatus(204); return }
  next()
})

// ── SQLite setup ──────────────────────────────────────────────────────────────

const requireCjs = createRequire(import.meta.url)
let db = null, stmtGetBody = null, stmtGetAtt = null
try {
  if (existsSync(DB_PATH)) {
    const Database = requireCjs('better-sqlite3')
    db = new Database(DB_PATH, { readonly: true })
    db.pragma('journal_mode = WAL')
    stmtGetBody = db.prepare('SELECT * FROM emails WHERE id = ?')
    stmtGetAtt = db.prepare('SELECT * FROM attachments WHERE id = ?')
    console.log(`  SQLite DB:    ${DB_PATH}`)
  } else {
    console.log(`  SQLite DB:    not found (run: node scripts/extract.js)`)
  }
} catch(e) { console.warn('SQLite:', e.message) }

// ── Helper: require fflate from pst-viewer node_modules ──────────────────────

let fflateLib = null
try {
  const fflateReq = createRequire(resolve(__dirname, 'pst-viewer/node_modules/'))
  fflateLib = fflateReq('fflate')
} catch (e) {
  console.warn('fflate not available:', e.message)
}

// ── EML builder ───────────────────────────────────────────────────────────────

function buildEml(email, attachments = []) {
  const lines = []
  if (email.sender_email) lines.push(`From: ${email.sender_name ? `"${email.sender_name}" ` : ''}<${email.sender_email}>`)
  if (email.recipients) lines.push(`To: ${email.recipients}`)
  if (email.recipients_cc) lines.push(`CC: ${email.recipients_cc}`)
  if (email.date_sent) lines.push(`Date: ${new Date(email.date_sent).toUTCString()}`)
  lines.push(`Subject: ${email.subject || ''}`)
  if (email.message_id) lines.push(`Message-ID: ${email.message_id}`)
  lines.push('MIME-Version: 1.0')

  if (attachments.length === 0) {
    if (email.body_html) {
      lines.push('Content-Type: text/html; charset="UTF-8"')
      lines.push('Content-Transfer-Encoding: base64')
      lines.push('')
      lines.push(Buffer.from(email.body_html).toString('base64').match(/.{1,76}/g)?.join('\r\n') || '')
    } else {
      lines.push('Content-Type: text/plain; charset="UTF-8"')
      lines.push('')
      lines.push(email.body_text || '')
    }
  } else {
    const boundary = `boundary_${Date.now()}`
    lines.push(`Content-Type: multipart/mixed; boundary="${boundary}"`)
    lines.push('')
    lines.push(`--${boundary}`)
    if (email.body_html) {
      lines.push('Content-Type: text/html; charset="UTF-8"')
      lines.push('Content-Transfer-Encoding: base64')
      lines.push('')
      lines.push(Buffer.from(email.body_html).toString('base64').match(/.{1,76}/g)?.join('\r\n') || '')
    } else {
      lines.push('Content-Type: text/plain; charset="UTF-8"')
      lines.push('')
      lines.push(email.body_text || '')
    }
    for (const att of attachments) {
      lines.push(`--${boundary}`)
      lines.push(`Content-Type: ${att.mime_type}`)
      lines.push('Content-Transfer-Encoding: base64')
      lines.push(`Content-Disposition: attachment; filename="${att.filename}"`)
      lines.push('')
      lines.push(Buffer.from(att.data).toString('base64').match(/.{1,76}/g)?.join('\r\n') || '')
    }
    lines.push(`--${boundary}--`)
  }
  return lines.join('\r\n')
}

// ── Helper: check DB ready ────────────────────────────────────────────────────

function requireDb(res) {
  if (!db) {
    res.status(503).json({
      error: 'Database not available. Run: node scripts/extract.js',
      hint: 'node scripts/extract.js',
    })
    return false
  }
  return true
}

// ── API: list available PST files ─────────────────────────────────────────────

app.get('/api/pst-files', async (req, res) => {
  try {
    const entries = await readdir(PST_DIR)
    const files = entries
      .filter(f => extname(f).toLowerCase() === '.pst')
      .sort()
      .map(name => {
        try {
          const { size } = statSync(join(PST_DIR, name))
          return { name, size }
        } catch {
          return null
        }
      })
      .filter(Boolean)

    res.json(files)
  } catch (err) {
    console.error('Cannot read PST directory:', err)
    res.status(500).json({ error: 'Cannot read PST directory: ' + String(err) })
  }
})

// ── API: DB status ────────────────────────────────────────────────────────────

app.get('/api/db-status', (req, res) => {
  if (!db) {
    return res.json({ ready: false, stats: null })
  }
  try {
    const folders = db.prepare('SELECT COUNT(*) as n FROM folders').get().n
    const emails = db.prepare('SELECT COUNT(*) as n FROM emails').get().n
    const attachments = db.prepare('SELECT COUNT(*) as n FROM attachments').get().n
    res.json({ ready: true, stats: { folders, emails, attachments } })
  } catch (e) {
    res.json({ ready: false, error: e.message })
  }
})

// ── API: folder tree ──────────────────────────────────────────────────────────

app.get('/api/folders', (req, res) => {
  if (!requireDb(res)) return
  try {
    // Aggregate email_count by canonical_path (merging across PST sources)
    const rows = db.prepare(`
      SELECT canonical_path, name, SUM(email_count) as email_count
      FROM folders
      GROUP BY canonical_path
      ORDER BY canonical_path
    `).all()

    // Build tree
    const root = { name: 'Mailbox', path: 'Mailbox', emailCount: 0, subFolderCount: 0, children: [] }

    for (const row of rows) {
      const parts = row.canonical_path.split(' / ')
      // parts[0] is 'Mailbox'
      let node = root
      for (let i = 1; i < parts.length; i++) {
        const part = parts[i]
        let child = node.children.find(c => c.name === part)
        if (!child) {
          const childPath = parts.slice(0, i + 1).join(' / ')
          child = { name: part, path: childPath, emailCount: 0, subFolderCount: 0, children: [] }
          node.children.push(child)
          node.subFolderCount++
        }
        if (i === parts.length - 1) {
          child.emailCount += (row.email_count || 0)
        }
        node = child
      }
    }

    res.json(root)
  } catch (e) {
    console.error('GET /api/folders error:', e)
    res.status(500).json({ error: e.message })
  }
})

// ── API: emails in folder ─────────────────────────────────────────────────────

app.get('/api/emails', (req, res) => {
  if (!requireDb(res)) return

  const folderPath = req.query.folder_path
  if (!folderPath) return res.status(400).json({ error: 'folder_path required' })

  const limit  = Math.min(parseInt(req.query.limit  || '500', 10), 5000)
  const offset = parseInt(req.query.offset || '0', 10)

  const VALID_SORT = new Set(['date_sent', 'date_received', 'subject', 'sender_name'])
  const sort  = VALID_SORT.has(req.query.sort)  ? req.query.sort  : 'date_sent'
  const order = req.query.order === 'asc' ? 'ASC' : 'DESC'

  try {
    const countRow = db.prepare(`
      SELECT COUNT(*) as n
      FROM emails e
      JOIN folders f ON f.id = e.folder_id
      WHERE f.canonical_path = ?
    `).get(folderPath)
    const total = countRow ? countRow.n : 0

    const emails = db.prepare(`
      SELECT e.id, e.folder_id, e.pst_source, e.subject, e.sender_name, e.sender_email,
             e.recipients, e.recipients_cc, e.date_sent, e.date_received,
             e.has_attachments, e.attachment_count, e.attachment_names,
             e.importance, e.is_read, e.message_id, e.message_class, e.item_type,
             e.location, e.start_time, e.end_time, e.task_status,
             e.contact_name, e.contact_phone, e.contact_company
      FROM emails e
      JOIN folders f ON f.id = e.folder_id
      WHERE f.canonical_path = ?
      ORDER BY e.${sort} ${order} NULLS LAST
      LIMIT ? OFFSET ?
    `).all(folderPath, limit, offset)

    res.json({ emails, total })
  } catch (e) {
    console.error('GET /api/emails error:', e)
    res.status(500).json({ error: e.message })
  }
})

// ── API: single email with body ───────────────────────────────────────────────

app.get('/api/email/:id', (req, res) => {
  if (!requireDb(res)) return
  try {
    const emailId = parseInt(req.params.id, 10)
    const email = stmtGetBody.get(emailId)
    if (!email) return res.status(404).json({ error: 'Email not found' })

    const attachments = db.prepare(
      'SELECT id, filename, mime_type, size FROM attachments WHERE email_id = ?'
    ).all(emailId)

    res.json({ ...email, attachments })
  } catch (e) {
    console.error('GET /api/email/:id error:', e)
    res.status(500).json({ error: e.message })
  }
})

// ── API: search ───────────────────────────────────────────────────────────────

app.get('/api/search', (req, res) => {
  if (!requireDb(res)) return

  const q = (req.query.q || '').trim()
  if (!q) return res.status(400).json({ error: 'q parameter required' })

  const folderPath = req.query.folder_path || null
  const limit  = Math.min(parseInt(req.query.limit  || '200', 10), 2000)
  const offset = parseInt(req.query.offset || '0', 10)

  try {
    // Support pipe-separated multi-term AND search: "mot de passe | orange | foo@bar.com"
    // All terms must be present (AND logic). Single term = classic exact-phrase search.
    const terms = q.split('|').map(t => t.trim()).filter(t => t.length > 0)

    // FTS5: each term as exact phrase, all must match (AND)
    const ftsQuery = terms.map(t => `"${t.replace(/"/g, '""')}"`).join(' AND ')

    // LIKE: for each term, it must appear in at least one field (AND between terms)
    const likeFilter = terms
      .map(() => `(e.subject LIKE ? OR e.body_text LIKE ? OR e.sender_name LIKE ? OR e.recipients LIKE ?)`)
      .join(' AND ')
    const likeParams = terms.flatMap(t => { const l = `%${t}%`; return [l, l, l, l] })

    let results, total

    try {
      // FTS5 pre-filters quickly by individual tokens (all must be present),
      // then the LIKE clause ensures they appear as an exact consecutive phrase
      const baseSql = `
        SELECT e.id, e.folder_id, e.subject, e.sender_name, e.sender_email,
               e.recipients, e.date_sent, e.has_attachments, e.item_type,
               f.canonical_path as folder_path
        FROM emails_fts
        JOIN emails e ON e.id = emails_fts.rowid
        JOIN folders f ON f.id = e.folder_id
        WHERE emails_fts MATCH ?
          AND ${likeFilter}
        ${folderPath ? 'AND f.canonical_path = ?' : ''}
        ORDER BY rank
        LIMIT ? OFFSET ?
      `
      const countSql = `
        SELECT COUNT(*) as n
        FROM emails_fts
        JOIN emails e ON e.id = emails_fts.rowid
        JOIN folders f ON f.id = e.folder_id
        WHERE emails_fts MATCH ?
          AND ${likeFilter}
        ${folderPath ? 'AND f.canonical_path = ?' : ''}
      `

      const params = folderPath
        ? [ftsQuery, ...likeParams, folderPath, limit, offset]
        : [ftsQuery, ...likeParams, limit, offset]
      const countParams = folderPath
        ? [ftsQuery, ...likeParams, folderPath]
        : [ftsQuery, ...likeParams]

      results = db.prepare(baseSql).all(...params)
      total   = db.prepare(countSql).get(...countParams).n
    } catch (ftsErr) {
      // FTS5 failed — fall back to pure LIKE search (slower but always correct)
      const baseSql = `
        SELECT e.id, e.folder_id, e.subject, e.sender_name, e.sender_email,
               e.recipients, e.date_sent, e.has_attachments, e.item_type,
               f.canonical_path as folder_path
        FROM emails e
        JOIN folders f ON f.id = e.folder_id
        WHERE ${likeFilter}
        ${folderPath ? 'AND f.canonical_path = ?' : ''}
        ORDER BY e.date_sent DESC NULLS LAST
        LIMIT ? OFFSET ?
      `
      const countSql = `
        SELECT COUNT(*) as n
        FROM emails e
        JOIN folders f ON f.id = e.folder_id
        WHERE ${likeFilter}
        ${folderPath ? 'AND f.canonical_path = ?' : ''}
      `
      const params = folderPath
        ? [...likeParams, folderPath, limit, offset]
        : [...likeParams, limit, offset]
      const countParams = folderPath
        ? [...likeParams, folderPath]
        : [...likeParams]

      results = db.prepare(baseSql).all(...params)
      total   = db.prepare(countSql).get(...countParams).n
    }

    res.json({ results, total })
  } catch (e) {
    console.error('GET /api/search error:', e)
    res.status(500).json({ error: e.message })
  }
})

// ── API: download attachment ──────────────────────────────────────────────────

app.get('/api/attachment/:id', (req, res) => {
  if (!requireDb(res)) return
  try {
    const att = stmtGetAtt.get(parseInt(req.params.id, 10))
    if (!att) return res.status(404).json({ error: 'Attachment not found' })

    const encodedName = encodeURIComponent(att.filename)
    res.setHeader('Content-Type', att.mime_type || 'application/octet-stream')
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodedName}`)
    res.setHeader('Content-Length', att.size)
    res.send(att.data)
  } catch (e) {
    console.error('GET /api/attachment/:id error:', e)
    res.status(500).json({ error: e.message })
  }
})

// ── API: export single email as EML ──────────────────────────────────────────

app.get('/api/export/eml/:id', (req, res) => {
  if (!requireDb(res)) return
  try {
    const emailId = parseInt(req.params.id, 10)
    const email = stmtGetBody.get(emailId)
    if (!email) return res.status(404).json({ error: 'Email not found' })

    const attachments = db.prepare(
      'SELECT * FROM attachments WHERE email_id = ?'
    ).all(emailId)

    const eml = buildEml(email, attachments)
    const safeSubject = (email.subject || 'email').replace(/[^a-zA-Z0-9_\- ]/g, '_').slice(0, 60)
    res.setHeader('Content-Type', 'message/rfc822')
    res.setHeader('Content-Disposition', `attachment; filename="${safeSubject}.eml"`)
    res.send(eml)
  } catch (e) {
    console.error('GET /api/export/eml/:id error:', e)
    res.status(500).json({ error: e.message })
  }
})

// ── API: bulk ZIP export ──────────────────────────────────────────────────────

app.post('/api/export', (req, res) => {
  if (!requireDb(res)) return
  if (!fflateLib) return res.status(503).json({ error: 'fflate not available' })

  const { zipSync, strToU8 } = fflateLib
  const { email_ids, include_attachments = false, folder_structure = true } = req.body || {}

  if (!Array.isArray(email_ids) || email_ids.length === 0) {
    return res.status(400).json({ error: 'email_ids array required' })
  }

  try {
    const files = {}
    const csvRows = ['id,date,from,to,subject,folder,has_attachments']
    const now = new Date()

    for (const emailId of email_ids) {
      const email = stmtGetBody.get(emailId)
      if (!email) continue

      let attachments = []
      if (include_attachments) {
        attachments = db.prepare('SELECT * FROM attachments WHERE email_id = ?').all(emailId)
      }

      const eml = buildEml(email, attachments)

      // Determine file path within ZIP
      const safeSubject = (email.subject || 'email').replace(/[^a-zA-Z0-9_\- ]/g, '_').slice(0, 60)
      const safeFolder = folder_structure
        ? (email.folder_path || '').replace(/[^a-zA-Z0-9_\- /]/g, '_').replace(/ \/ /g, '/')
        : ''
      const filePath = safeFolder
        ? `${safeFolder}/${emailId}_${safeSubject}.eml`
        : `${emailId}_${safeSubject}.eml`

      files[filePath] = strToU8(eml)

      // CSV row
      const csvDate = email.date_sent ? new Date(email.date_sent).toISOString() : ''
      const csvFrom = email.sender_email || ''
      const csvTo = (email.recipients || '').replace(/,/g, ';')
      const csvSubj = (email.subject || '').replace(/,/g, ';')
      const csvFolder = (email.folder_path || '').replace(/,/g, ';')
      csvRows.push(`${emailId},"${csvDate}","${csvFrom}","${csvTo}","${csvSubj}","${csvFolder}",${email.has_attachments ? 1 : 0}`)
    }

    // Add index.csv
    files['index.csv'] = strToU8(csvRows.join('\n'))

    // Add custody.txt
    const custodyTxt = [
      'PST Archive Export',
      `Date: ${now.toISOString()}`,
      `Database: ${DB_PATH}`,
      `Email count: ${email_ids.length}`,
      `Include attachments: ${include_attachments}`,
    ].join('\n')
    files['custody.txt'] = strToU8(custodyTxt)

    const zip = zipSync(files)
    const dateStr = now.toISOString().slice(0, 10)
    res.setHeader('Content-Type', 'application/zip')
    res.setHeader('Content-Disposition', `attachment; filename="export_${dateStr}.zip"`)
    res.send(Buffer.from(zip))
  } catch (e) {
    console.error('POST /api/export error:', e)
    res.status(500).json({ error: e.message })
  }
})

// ── Serve PST files with range-request support ───────────────────────────────
// Workers use synchronous XHR range requests to read PST data on demand.

app.get('/pst-files/:filename', (req, res) => {
  // Prevent path traversal: only allow bare filenames
  const name = basename(req.params.filename)
  if (!name.toLowerCase().endsWith('.pst') || name !== req.params.filename) {
    res.status(400).send('Invalid filename')
    return
  }

  const filePath = join(PST_DIR, name)
  let stat
  try {
    stat = statSync(filePath)
  } catch {
    res.status(404).send('File not found')
    return
  }

  const fileSize = stat.size
  const rangeHeader = req.headers['range']

  if (rangeHeader) {
    // Honour byte-range request (RFC 7233)
    const match = rangeHeader.match(/^bytes=(\d*)-(\d*)$/)
    if (!match) {
      res.status(416).setHeader('Content-Range', `bytes */${fileSize}`).send()
      return
    }

    const start = match[1] ? parseInt(match[1], 10) : fileSize - parseInt(match[2], 10)
    const end   = match[2] ? parseInt(match[2], 10) : fileSize - 1

    if (start > end || end >= fileSize) {
      res.status(416).setHeader('Content-Range', `bytes */${fileSize}`).send()
      return
    }

    res.writeHead(206, {
      'Content-Type':   'application/octet-stream',
      'Content-Range':  `bytes ${start}-${end}/${fileSize}`,
      'Content-Length': String(end - start + 1),
      'Accept-Ranges':  'bytes',
      'Cache-Control':  'no-store',
    })
    createReadStream(filePath, { start, end }).pipe(res)
  } else {
    // Full file request
    res.writeHead(200, {
      'Content-Type':   'application/octet-stream',
      'Content-Length': String(fileSize),
      'Accept-Ranges':  'bytes',
      'Cache-Control':  'no-store',
    })
    createReadStream(filePath).pipe(res)
  }
})

// ── Serve frontend ────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  try {
    statSync(FRONTEND)
    res.sendFile(FRONTEND)
  } catch {
    res.status(404).send(
      'Frontend not built yet. Run: cd pst-viewer && npm install && npm run build\n' +
      `Expected at: ${FRONTEND}`
    )
  }
})

// ── Start ─────────────────────────────────────────────────────────────────────

const HOST = process.env.HOST || '0.0.0.0'

app.listen(PORT, HOST, () => {
  console.log(`\nPST Archive Server`)
  console.log(`  URL:          http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`)
  console.log(`  Listen:       ${HOST}:${PORT}`)
  console.log(`  PST files:    ${PST_DIR}`)
  console.log(`  Frontend:     ${FRONTEND}`)
  console.log(`  Auth:         ${PASSWORD ? 'enabled (Basic Auth)' : 'disabled'}`)
  console.log()
})
