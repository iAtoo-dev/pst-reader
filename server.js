/**
 * PST Archive Server
 *
 * Configuration via environment variables:
 *   PST_DIR      Directory containing .pst files  (default: ./pst-files)
 *   PST_PASSWORD Password for Basic Auth          (default: empty = no auth)
 *   PORT         HTTP port                        (default: 3000)
 *   FRONTEND     Path to the built frontend HTML  (default: ./pst-viewer/dist/index.html)
 */

import express from 'express'
import { createReadStream, statSync } from 'fs'
import { readdir } from 'fs/promises'
import { join, extname, basename, resolve } from 'path'
import { timingSafeEqual, createHash } from 'crypto'
import { fileURLToPath } from 'url'

const __dirname = fileURLToPath(new URL('.', import.meta.url))

const PST_DIR  = resolve(process.env.PST_DIR  || join(__dirname, 'pst-files'))
const PORT     = parseInt(process.env.PORT     || '3000', 10)
const PASSWORD = process.env.PST_PASSWORD      || ''
const FRONTEND = resolve(process.env.FRONTEND  || join(__dirname, 'pst-viewer', 'dist', 'index.html'))

const app = express()

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

app.listen(PORT, () => {
  console.log(`\nPST Archive Server`)
  console.log(`  URL:          http://localhost:${PORT}`)
  console.log(`  PST files:    ${PST_DIR}`)
  console.log(`  Frontend:     ${FRONTEND}`)
  console.log(`  Auth:         ${PASSWORD ? 'enabled (Basic Auth)' : 'disabled'}`)
  console.log()
})
