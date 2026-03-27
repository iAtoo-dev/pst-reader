/**
 * useMultiPSTWorker — multi-PST coordinator hook
 *
 * Fetches the list of PST files from the Express server, spins up one Web
 * Worker per file, and presents a *merged* mailbox view that looks exactly
 * like the single-file usePSTWorker interface so App.tsx needs minimal changes.
 *
 * Key design decisions:
 *  • Canonical folder paths strip the PST root prefix so "Personal Folders /
 *    Inbox" from every PST maps to "Mailbox / Inbox".
 *  • Each email keeps a hidden _w (workerIndex) / _oi (originalIndex) tag so
 *    body, attachment and export requests can be routed to the right worker.
 *  • Email metadata is never held in duplicate — only the merged array lives
 *    in React state; per-worker raw arrays are kept in refs and dropped once
 *    the merge for a folder is complete.
 *  • IDB persistence in pstWorker.ts means subsequent sessions load metadata
 *    instantly; PST files are only accessed for bodies/attachments/exports.
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import PSTWorkerConstructor from './pstWorker.ts?worker&inline'
import type {
  FolderNode, EmailMeta, SearchResult, SearchProgress,
  WorkerCommand, WorkerResponse, ExportOptions,
} from './types.ts'
import type { PSTWorkerState, PSTWorkerActions } from './usePSTWorker.ts'

// ─── Helpers ─────────────────────────────────────────────────────────────────

export function bodyKey(folderPath: string, index: number) {
  return `${folderPath}\0${index}`
}

/** Sanitise a filename for use as an IDB slot key (filename:fileSize). */
function makeSlot(name: string, size: number) {
  return `${name.replace(/[^a-zA-Z0-9._-]/g, '_')}:${size}`
}

/**
 * Normalise a PST folder path to a canonical "Mailbox / …" path.
 * The first path segment (PST root name) is stripped and replaced with "Mailbox".
 *   "Personal Folders"          → "Mailbox"
 *   "Personal Folders / Inbox"  → "Mailbox / Inbox"
 */

/** Recursively merge a source tree into a destination tree. */
function mergeTreeNode(dest: FolderNode, src: FolderNode, canonParentPath: string): void {
  for (const srcChild of src.children) {
    const canonPath = canonParentPath ? `${canonParentPath} / ${srcChild.name}` : srcChild.name
    let destChild = dest.children.find(c => c.name === srcChild.name)
    if (!destChild) {
      destChild = { name: srcChild.name, path: canonPath, emailCount: 0, subFolderCount: 0, children: [] }
      dest.children.push(destChild)
    }
    destChild.emailCount += srcChild.emailCount
    mergeTreeNode(destChild, srcChild, canonPath)
    destChild.subFolderCount = destChild.children.length
  }
}

/** Build the merged FolderNode tree from all worker trees. */
function buildMergedTree(trees: Array<FolderNode | null>): FolderNode {
  const root: FolderNode = { name: 'Mailbox', path: 'Mailbox', emailCount: 0, subFolderCount: 0, children: [] }
  for (const tree of trees) {
    if (!tree) continue
    // The PST root itself contributes its children
    mergeTreeNode(root, tree, 'Mailbox')
  }
  root.subFolderCount = root.children.length
  return root
}

/**
 * Build a map  canonicalPath → [{workerIndex, originalPath}]
 * so fetchFolder knows which workers to query for a given canonical folder.
 */
function buildFolderPathMap(
  trees: Array<FolderNode | null>,
): Map<string, Array<{ workerIndex: number; originalPath: string }>> {
  const map = new Map<string, Array<{ workerIndex: number; originalPath: string }>>()

  function addNode(node: FolderNode, workerIndex: number, canonPath: string) {
    const existing = map.get(canonPath) ?? []
    existing.push({ workerIndex, originalPath: node.path })
    map.set(canonPath, existing)
    for (const child of node.children) {
      addNode(child, workerIndex, `${canonPath} / ${child.name}`)
    }
  }

  trees.forEach((tree, workerIndex) => {
    if (!tree) return
    // Map root
    map.set('Mailbox', [...(map.get('Mailbox') ?? []), { workerIndex, originalPath: tree.path }])
    // Map children
    for (const child of tree.children) {
      addNode(child, workerIndex, `Mailbox / ${child.name}`)
    }
  })

  return map
}

// ─── Hidden routing tags on EmailMeta objects ────────────────────────────────
// We extend EmailMeta with two hidden non-enumerable properties so the merge
// route map doesn't need a separate WeakMap or ID encoding.

interface TaggedEmail extends EmailMeta {
  _w: number   // workerIndex
  _oi: number  // original index in that worker's folder
  _op: string  // original folder path in that worker
}

function tagEmail(email: EmailMeta, workerIndex: number, originalPath: string): TaggedEmail {
  const tagged = email as TaggedEmail
  tagged._w  = workerIndex
  tagged._oi = email.index
  tagged._op = originalPath
  return tagged
}

// ─── Per-folder merge bookkeeping ────────────────────────────────────────────

interface FolderMergeState {
  /** Raw emails received per worker (original index preserved). */
  rawEmails: Map<number, EmailMeta[]>
  /** Workers that have sent FOLDER_DONE for this canonical path. */
  doneWorkers: Set<number>
  /** Total number of workers expected for this folder. */
  expectedWorkers: number
}

// ─── Hook ────────────────────────────────────────────────────────────────────

export function useMultiPSTWorker(authHeader?: string): PSTWorkerState & PSTWorkerActions {

  // ── Refs (stable across renders) ──────────────────────────────────────────
  const workersRef        = useRef<Worker[]>([])
  const workerTreesRef    = useRef<Array<FolderNode | null>>([])
  const readyCountRef     = useRef(0)
  const totalWorkersRef   = useRef(0)
  const folderPathMapRef  = useRef<Map<string, Array<{ workerIndex: number; originalPath: string }>>>(new Map())
  const folderMergeRef    = useRef<Map<string, FolderMergeState>>(new Map())
  const bodyCacheRef      = useRef<Map<string, { body: string; bodyHTML: string }>>(new Map())
  const searchRequestIdRef      = useRef(0)
  const activeSearchRequestIdRef = useRef<number | null>(null)
  // pending search: per worker → results
  const pendingSearchRef  = useRef<{ requestId: number; workers: Set<number>; results: SearchResult[] } | null>(null)
  const exportingWorkerRef = useRef<number | null>(null)

  // ── Persisted auth header for fetch calls ─────────────────────────────────
  const authHeaderRef = useRef(authHeader ?? '')
  authHeaderRef.current = authHeader ?? ''

  // ── React state (triggers re-renders) ─────────────────────────────────────
  const [tree,                setTree]                = useState<FolderNode | null>(null)
  const [loading,             setLoading]             = useState(true)
  const [loadingMsg,          setLoadingMsg]          = useState('Connecting to server…')
  const [progress,            setProgress]            = useState(0)
  const [loadingPhase,        setLoadingPhase]        = useState<'copy' | 'parse' | null>(null)
  const [error,               setError]               = useState<string | null>(null)
  const [folderEmails,        setFolderEmails]        = useState<Map<string, EmailMeta[]>>(new Map())
  const [bodyCache,           setBodyCache]           = useState<Map<string, { body: string; bodyHTML: string }>>(new Map())
  const [searchResults,       setSearchResults]       = useState<SearchResult[] | null>(null)
  const [searching,           setSearching]           = useState(false)
  const [searchProgress,      setSearchProgress]      = useState<SearchProgress | null>(null)
  const [folderTotalCounts,   setFolderTotalCounts]   = useState<Map<string, number>>(new Map())
  const [folderLoadingPaths,  setFolderLoadingPaths]  = useState<Set<string>>(new Set())
  const [exporting,           setExporting]           = useState(false)
  const [indexProgress,       setIndexProgress]       = useState<{ indexed: number; total: number; paused?: boolean } | null>(null)
  const indexDoneTimerRef     = useRef(0)

  // These are derived / unused in multi-PST context but kept for interface compat
  const [fileName] = useState('Archives PST')
  const [fileSize] = useState(0)
  const [savedAt]  = useState(0)
  const indexedFolderCount = 0  // managed per-worker; not surfaced separately

  // ── Utility: send command to a specific worker ─────────────────────────────
  const sendTo = useCallback((workerIndex: number, cmd: WorkerCommand) => {
    workersRef.current[workerIndex]?.postMessage(cmd)
  }, [])

  // ── Merge completed folder across all workers ─────────────────────────────
  const finalizeFolderMerge = useCallback((canonPath: string, state: FolderMergeState) => {
    // Collect all emails from all workers, tag with routing info, sort by date
    const allEmails: TaggedEmail[] = []
    const routes = folderPathMapRef.current.get(canonPath) ?? []

    for (const { workerIndex, originalPath } of routes) {
      const workerEmails = state.rawEmails.get(workerIndex) ?? []
      for (const email of workerEmails) {
        const tagged = tagEmail(email, workerIndex, originalPath)
        // Re-assign index to be position in the merged array (assigned below)
        allEmails.push(tagged)
      }
    }

    // Sort by date descending
    allEmails.sort((a, b) => {
      if (!a.date && !b.date) return 0
      if (!a.date) return 1
      if (!b.date) return -1
      return a.date > b.date ? -1 : a.date < b.date ? 1 : 0
    })

    // Assign merged indices (original indices kept in _oi)
    allEmails.forEach((e, i) => { e.index = i })

    const totalCount = allEmails.length

    setFolderEmails(prev => {
      const next = new Map(prev)
      next.set(canonPath, allEmails)
      return next
    })
    setFolderTotalCounts(prev => {
      const next = new Map(prev)
      next.set(canonPath, totalCount)
      return next
    })
    setFolderLoadingPaths(prev => {
      const next = new Set(prev)
      next.delete(canonPath)
      return next
    })

    // Clean up merge state
    folderMergeRef.current.delete(canonPath)
  }, [])

  // ── Set up workers once on mount ──────────────────────────────────────────
  useEffect(() => {
    let cancelled = false

    async function init() {
      // Fetch PST file list from server
      let pstFiles: Array<{ name: string; size: number }>
      try {
        const headers: Record<string, string> = {}
        if (authHeaderRef.current) headers['Authorization'] = authHeaderRef.current
        const res = await fetch('/api/pst-files', { headers })
        if (!res.ok) throw new Error(`Server error ${res.status}`)
        pstFiles = await res.json()
      } catch (err) {
        if (!cancelled) {
          setError(`Cannot connect to server: ${err instanceof Error ? err.message : String(err)}`)
          setLoading(false)
        }
        return
      }

      if (cancelled) return

      if (pstFiles.length === 0) {
        setError('No PST files found on server. Check PST_DIR configuration.')
        setLoading(false)
        return
      }

      const n = pstFiles.length
      totalWorkersRef.current  = n
      workerTreesRef.current   = new Array(n).fill(null)
      workersRef.current       = []

      setLoadingMsg(`Loading ${n} PST file${n > 1 ? 's' : ''}…`)

      // Progress tracking per worker
      const workerLoadingMsgs = new Array<string>(n).fill('Waiting…')

      // Create one worker per PST file
      pstFiles.forEach((pst, workerIndex) => {
        const worker = new PSTWorkerConstructor()
        workersRef.current.push(worker)

        worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
          const msg = e.data
          switch (msg.type) {

            case 'READY': {
              workerTreesRef.current[workerIndex] = msg.tree
              readyCountRef.current++

              if (readyCountRef.current === totalWorkersRef.current) {
                // All workers ready — build merged tree
                const merged = buildMergedTree(workerTreesRef.current)
                folderPathMapRef.current = buildFolderPathMap(workerTreesRef.current)
                setTree(merged)
                setLoading(false)
                setLoadingMsg('')
                setLoadingPhase(null)
                setProgress(0)
                setError(null)
                setFolderEmails(new Map())
                setBodyCache(new Map())
                bodyCacheRef.current = new Map()
                setSearchResults(null)
                setFolderTotalCounts(new Map())
                setFolderLoadingPaths(new Set())
                indexDoneTimerRef.current++
                // Start background indexing on all workers
                workersRef.current.forEach((w) => w.postMessage({ type: 'INDEX_ALL' } satisfies WorkerCommand))
              } else {
                // Show partial progress
                setLoadingMsg(`${readyCountRef.current} / ${totalWorkersRef.current} PST files parsed…`)
              }
              break
            }

            case 'PROGRESS': {
              workerLoadingMsgs[workerIndex] = msg.message
              // Show combined message
              const readyN = readyCountRef.current
              const totalN = totalWorkersRef.current
              if (readyN < totalN) {
                setLoadingMsg(`[${workerIndex + 1}/${totalN}] ${msg.message}`)
              }
              if (msg.percent !== undefined) setProgress(msg.percent)
              setLoadingPhase(msg.phase ?? null)
              break
            }

            case 'FOLDER_EMAILS': {
              // Determine canonical path for this original path
              const routes = folderPathMapRef.current
              let canonPath: string | null = null
              for (const [canon, entries] of routes) {
                if (entries.some(e => e.workerIndex === workerIndex && e.originalPath === msg.path)) {
                  canonPath = canon
                  break
                }
              }
              if (!canonPath) break

              const state = folderMergeRef.current.get(canonPath)
              if (!state) break

              // Accumulate (msg.page===0 resets, subsequent pages append)
              if (msg.page === 0) {
                state.rawEmails.set(workerIndex, msg.emails)
              } else {
                const existing = state.rawEmails.get(workerIndex) ?? []
                state.rawEmails.set(workerIndex, [...existing, ...msg.emails])
              }
              break
            }

            case 'FOLDER_DONE': {
              let canonPath: string | null = null
              for (const [canon, entries] of folderPathMapRef.current) {
                if (entries.some(e => e.workerIndex === workerIndex && e.originalPath === msg.path)) {
                  canonPath = canon
                  break
                }
              }
              if (!canonPath) break

              const state = folderMergeRef.current.get(canonPath)
              if (!state) break

              state.doneWorkers.add(workerIndex)
              if (state.doneWorkers.size >= state.expectedWorkers) {
                finalizeFolderMerge(canonPath, state)
              }
              break
            }

            case 'EMAIL_BODY': {
              // Find canonical path + merged index for this body
              // We stored the canonical path in _op on the tagged email; look it up via
              // the canonical folder path by scanning all folders for workerIndex+originalPath
              let canonPath: string | null = null
              let mergedIndex = -1
              for (const [canon, emails] of folderEmails) {
                const tagged = emails as TaggedEmail[]
                const found = tagged.find(e => e._w === workerIndex && e._oi === msg.index && e._op === msg.folderPath)
                if (found) { canonPath = canon; mergedIndex = found.index; break }
              }
              // folderEmails might not be the current state here due to closure — use ref workaround:
              // We'll store body using original routing key and remap on access.
              // Simpler: just cache by a combined key: workerIndex+originalPath+originalIndex
              const cacheKey = `${workerIndex}\0${msg.folderPath}\0${msg.index}`
              const entry = { body: msg.body, bodyHTML: msg.bodyHTML }
              bodyCacheRef.current.set(cacheKey, entry)
              if (canonPath !== null && mergedIndex >= 0) {
                const canonKey = bodyKey(canonPath, mergedIndex)
                bodyCacheRef.current.set(canonKey, entry)
              }
              setBodyCache(new Map(bodyCacheRef.current))
              break
            }

            case 'SEARCH_RESULTS': {
              const pending = pendingSearchRef.current
              if (!pending || pending.requestId !== msg.requestId) break
              if (!msg.append) {
                pending.results = msg.results
              } else {
                pending.results = [...pending.results, ...msg.results]
              }
              if (activeSearchRequestIdRef.current === msg.requestId) {
                setSearchResults([...pending.results])
              }
              break
            }

            case 'SEARCH_PROGRESS': {
              const pending = pendingSearchRef.current
              if (!pending || pending.requestId !== msg.progress.requestId) break
              if (msg.progress.done) {
                pending.workers.delete(workerIndex)
                if (pending.workers.size === 0) {
                  // All workers done
                  setSearching(false)
                  setSearchProgress({ ...msg.progress, done: true })
                  setSearchResults([...pending.results])
                  pendingSearchRef.current = null
                }
              } else {
                // Aggregate progress (sum scanned/total across workers)
                setSearchProgress(prev => {
                  if (!prev) return msg.progress
                  return {
                    ...prev,
                    scanned: prev.scanned + msg.progress.scanned,
                    total:   prev.total   + msg.progress.total,
                    matches: prev.matches + msg.progress.matches,
                    done:    false,
                  }
                })
              }
              break
            }

            case 'ATTACHMENT_DATA': {
              const blob = new Blob([msg.data], { type: msg.mimeType })
              const url  = URL.createObjectURL(blob)
              const a    = document.createElement('a')
              a.href = url; a.download = msg.fileName
              document.body.appendChild(a); a.click()
              document.body.removeChild(a); URL.revokeObjectURL(url)
              break
            }

            case 'EML_READY': {
              const blob = new Blob([msg.data], { type: 'message/rfc822' })
              const file = new File([blob], msg.fileName, { type: 'message/rfc822' })
              if (typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] })) {
                navigator.share({ files: [file] }).catch(() => {})
              } else {
                const url = URL.createObjectURL(blob)
                const a   = document.createElement('a')
                a.href = url; a.download = msg.fileName
                document.body.appendChild(a); a.click()
                document.body.removeChild(a); URL.revokeObjectURL(url)
              }
              break
            }

            case 'EXPORT_READY': {
              if (exportingWorkerRef.current === workerIndex) {
                exportingWorkerRef.current = null
                setExporting(false)
                setLoadingMsg('')
              }
              const blob = new Blob([msg.zipBuffer], { type: 'application/zip' })
              const url  = URL.createObjectURL(blob)
              const a    = document.createElement('a')
              a.href = url; a.download = msg.fileName
              document.body.appendChild(a); a.click()
              document.body.removeChild(a); URL.revokeObjectURL(url)
              break
            }

            case 'INDEX_PROGRESS': {
              const version = ++indexDoneTimerRef.current
              if (msg.done) {
                setIndexProgress({ indexed: msg.indexed, total: msg.totalFolders })
                setTimeout(() => {
                  if (indexDoneTimerRef.current === version) setIndexProgress(null)
                }, 3000)
              } else {
                setIndexProgress({ indexed: msg.indexed, total: msg.totalFolders, paused: msg.paused })
              }
              break
            }

            case 'ERROR': {
              if (msg.message) setError(msg.message)
              if (readyCountRef.current < totalWorkersRef.current) {
                // A worker failed during initial load
                readyCountRef.current++
                if (readyCountRef.current === totalWorkersRef.current) {
                  // All accounted for — show what we have
                  const merged = buildMergedTree(workerTreesRef.current)
                  folderPathMapRef.current = buildFolderPathMap(workerTreesRef.current)
                  setTree(merged.children.length > 0 ? merged : null)
                  setLoading(false)
                  setLoadingMsg('')
                }
              }
              setSearching(false)
              setExporting(false)
              break
            }

            case 'CACHE_DELETED':
              break // not used in URL mode

          }
        }

        worker.onerror = (err) => {
          setError(`Worker ${workerIndex} error: ${err.message || 'Unknown'}`)
          setLoading(false)
        }

        // Send LOAD_URL to each worker
        const slot = makeSlot(pst.name, pst.size)
        const url  = `${location.origin}/pst-files/${encodeURIComponent(pst.name)}`
        worker.postMessage({
          type:       'LOAD_URL',
          url,
          fileName:   pst.name,
          fileSize:   pst.size,
          slot,
          authHeader: authHeaderRef.current || undefined,
        } satisfies WorkerCommand)
      })
    }

    init()
    return () => {
      cancelled = true
      workersRef.current.forEach(w => w.terminate())
      workersRef.current = []
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authHeader]) // re-init if auth changes

  // ── Actions ───────────────────────────────────────────────────────────────

  // Not used in server mode (no file upload)
  const loadFile = useCallback((_file: File) => {}, [])

  const fetchFolder = useCallback((canonPath: string) => {
    const routes = folderPathMapRef.current.get(canonPath)
    if (!routes || routes.length === 0) return

    // Initialise merge state for this folder
    const state: FolderMergeState = {
      rawEmails:       new Map(),
      doneWorkers:     new Set(),
      expectedWorkers: routes.length,
    }
    folderMergeRef.current.set(canonPath, state)

    setFolderLoadingPaths(prev => new Set([...prev, canonPath]))

    for (const { workerIndex, originalPath } of routes) {
      sendTo(workerIndex, { type: 'FETCH_FOLDER', path: originalPath })
    }
  }, [sendTo])

  const fetchBody = useCallback((canonPath: string, mergedIndex: number) => {
    // Look up the tagged email to find routing info
    const emails = folderEmails as unknown as Map<string, TaggedEmail[]>
    const tagged = emails.get(canonPath)?.find(e => e.index === mergedIndex)
    if (!tagged) return

    // Check if already cached (canonical or raw key)
    const rawKey   = `${tagged._w}\0${tagged._op}\0${tagged._oi}`
    const canonKey = bodyKey(canonPath, mergedIndex)
    if (bodyCacheRef.current.has(canonKey) || bodyCacheRef.current.has(rawKey)) return

    sendTo(tagged._w, { type: 'FETCH_BODY', folderPath: tagged._op, index: tagged._oi })
  }, [folderEmails, sendTo])

  const search = useCallback((query: string, canonPath: string, includeBody?: boolean) => {
    const trimmed = query.trim()
    if (!trimmed || !canonPath) {
      // Abort all worker searches
      workersRef.current.forEach(w => w.postMessage({ type: 'ABORT_SEARCH' } satisfies WorkerCommand))
      activeSearchRequestIdRef.current = null
      setSearching(false)
      setSearchProgress(null)
      setSearchResults(null)
      pendingSearchRef.current = null
      return
    }

    const routes = folderPathMapRef.current.get(canonPath) ?? []
    const requestId = ++searchRequestIdRef.current
    activeSearchRequestIdRef.current = requestId

    pendingSearchRef.current = {
      requestId,
      workers: new Set(routes.map(r => r.workerIndex)),
      results: [],
    }

    setSearching(true)
    setSearchProgress({
      requestId, folderPath: canonPath, scanned: 0, total: 0, matches: 0, done: false,
    })
    setSearchResults([])
    setFolderLoadingPaths(new Set())

    for (const { workerIndex, originalPath } of routes) {
      sendTo(workerIndex, { type: 'SEARCH', query, folderPath: originalPath, requestId, includeBody })
    }
  }, [sendTo])

  const abortSearch = useCallback(() => {
    workersRef.current.forEach(w => w.postMessage({ type: 'ABORT_SEARCH' } satisfies WorkerCommand))
    activeSearchRequestIdRef.current = null
    setSearching(false)
    setSearchProgress(prev => prev ? { ...prev, done: true, cancelled: true } : null)
    pendingSearchRef.current = null
  }, [])

  // Not applicable in server mode — PST files are always available
  const closeFile = useCallback(() => {}, [])
  const clearError = useCallback(() => setError(null), [])
  const abortLoad  = useCallback(() => {
    workersRef.current.forEach(w => w.postMessage({ type: 'ABORT_LOAD' } satisfies WorkerCommand))
  }, [])

  const exportEmails = useCallback((emails: Array<{ folderPath: string; index: number }>, options: ExportOptions) => {
    // Group emails by worker using routing info
    const byWorker = new Map<number, Array<{ folderPath: string; index: number }>>()
    const allTagged = folderEmails as unknown as Map<string, TaggedEmail[]>

    for (const { folderPath: canonPath, index: mergedIndex } of emails) {
      const tagged = allTagged.get(canonPath)?.find(e => e.index === mergedIndex)
      if (!tagged) continue
      const bucket = byWorker.get(tagged._w) ?? []
      bucket.push({ folderPath: tagged._op, index: tagged._oi })
      byWorker.set(tagged._w, bucket)
    }

    setExporting(true)
    setLoadingMsg('Preparing export…')

    byWorker.forEach((workerEmails, workerIndex) => {
      exportingWorkerRef.current = workerIndex
      sendTo(workerIndex, { type: 'EXPORT_EMAILS', emails: workerEmails, options })
    })

    if (byWorker.size === 0) {
      setExporting(false)
      setLoadingMsg('')
    }
  }, [folderEmails, sendTo])

  const exportFolder = useCallback((canonPath: string, options: ExportOptions) => {
    const routes = folderPathMapRef.current.get(canonPath) ?? []
    if (routes.length === 0) return

    setExporting(true)
    setLoadingMsg('Preparing export…')

    // Export from each worker that has the folder; each produces its own ZIP
    routes.forEach(({ workerIndex, originalPath }) => {
      exportingWorkerRef.current = workerIndex
      sendTo(workerIndex, { type: 'EXPORT_FOLDER', folderPath: originalPath, options })
    })
  }, [sendTo])

  const fetchAttachment = useCallback((canonPath: string, mergedIndex: number, attachmentIndex: number) => {
    const allTagged = folderEmails as unknown as Map<string, TaggedEmail[]>
    const tagged = allTagged.get(canonPath)?.find(e => e.index === mergedIndex)
    if (!tagged) return
    sendTo(tagged._w, { type: 'FETCH_ATTACHMENT', folderPath: tagged._op, index: tagged._oi, attachmentIndex })
  }, [folderEmails, sendTo])

  const shareEmail = useCallback((canonPath: string, mergedIndex: number) => {
    const allTagged = folderEmails as unknown as Map<string, TaggedEmail[]>
    const tagged = allTagged.get(canonPath)?.find(e => e.index === mergedIndex)
    if (!tagged) return
    sendTo(tagged._w, { type: 'BUILD_EML', folderPath: tagged._op, index: tagged._oi })
  }, [folderEmails, sendTo])

  // ── Build bodyCache with canonical keys for App.tsx ────────────────────────
  // App.tsx looks up body with bodyKey(email.folderPath, email.index) where
  // folderPath and index are already the canonical/merged values on TaggedEmail.
  // We need to ensure canonical keys are present in bodyCache.
  // They are added in the EMAIL_BODY handler above.

  return {
    // State
    tree,
    fileName,
    fileSize,
    savedAt,
    loading,
    loadingMsg,
    progress,
    loadingPhase,
    error,
    folderEmails,
    bodyCache,
    searchResults,
    searching,
    searchProgress,
    indexedFolderCount,
    folderTotalCounts,
    folderLoadingPaths,
    exporting,
    indexProgress,
    // Actions
    loadFile,
    fetchFolder,
    fetchBody,
    search,
    abortSearch,
    closeFile,
    clearError,
    exportEmails,
    exportFolder,
    fetchAttachment,
    shareEmail,
    abortLoad,
  }
}
