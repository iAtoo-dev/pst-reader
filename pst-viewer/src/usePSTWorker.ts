import { useState, useEffect, useCallback, useRef } from 'react'
import PSTWorkerConstructor from './pstWorker.ts?worker&inline'
import type { FolderNode, EmailMeta, SearchResult, SearchProgress, WorkerCommand, WorkerResponse, ExportOptions } from './types.ts'

export interface PSTWorkerState {
  tree: FolderNode | null
  fileName: string
  fileSize: number
  savedAt: number
  loading: boolean
  loadingMsg: string
  progress: number
  loadingPhase: 'copy' | 'parse' | null
  error: string | null
  folderEmails: Map<string, EmailMeta[]>
  bodyCache: Map<string, { body: string; bodyHTML: string }>
  searchResults: SearchResult[] | null
  searching: boolean
  searchProgress: SearchProgress | null
  indexedFolderCount: number
  folderTotalCounts: Map<string, number>
  folderLoadingPaths: Set<string>
  exporting: boolean
  indexProgress: { indexed: number; total: number; paused?: boolean } | null
}

export interface PSTWorkerActions {
  loadFile: (file: File) => void
  fetchFolder: (path: string) => void
  fetchBody: (folderPath: string, index: number) => void
  search: (query: string, folderPath: string, includeBody?: boolean, dateFrom?: string, dateTo?: string) => void
  abortSearch: () => void
  closeFile: () => void
  clearError: () => void
  exportEmails: (emails: Array<{ folderPath: string; index: number }>, options: ExportOptions) => void
  exportFolder: (folderPath: string, options: ExportOptions) => void
  fetchAttachment: (folderPath: string, index: number, attachmentIndex: number) => void
  shareEmail: (folderPath: string, index: number) => void
  abortLoad: () => void
}

const MAX_BODY_CACHE = 100

function bodyKey(folderPath: string, index: number) {
  return `${folderPath}\0${index}`
}

export function usePSTWorker(): PSTWorkerState & PSTWorkerActions {
  const workerRef = useRef<Worker | null>(null)
  const bodyCacheRef = useRef<Map<string, { body: string; bodyHTML: string }>>(new Map())
  const searchRequestIdRef = useRef(0)
  const activeSearchRequestIdRef = useRef<number | null>(null)

  const [tree, setTree] = useState<FolderNode | null>(null)
  const [fileName, setFileName] = useState('')
  const [fileSize, setFileSize] = useState(0)
  const [savedAt, setSavedAt] = useState(0)
  const [loading, setLoading] = useState(true)
  const [loadingMsg, setLoadingMsg] = useState('Gespeicherte Datei wird geladen...')
  const [progress, setProgress] = useState(0)
  const [loadingPhase, setLoadingPhase] = useState<'copy' | 'parse' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [folderEmails, setFolderEmails] = useState<Map<string, EmailMeta[]>>(new Map())
  const [bodyCache, setBodyCache] = useState<Map<string, { body: string; bodyHTML: string }>>(new Map())
  const [searchResults, setSearchResults] = useState<SearchResult[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [searchProgress, setSearchProgress] = useState<SearchProgress | null>(null)
  const [searchableFolderCount, setSearchableFolderCount] = useState(0)
  const [folderTotalCounts, setFolderTotalCounts] = useState<Map<string, number>>(new Map())
  const [folderLoadingPaths, setFolderLoadingPaths] = useState<Set<string>>(new Set())
  const [exporting, setExporting] = useState(false)
  const [indexProgress, setIndexProgress] = useState<{ indexed: number; total: number; paused?: boolean } | null>(null)
  const indexDoneTimerRef = useRef(0) // version counter to cancel stale done-timers
  // Use worker-reported searchable count (reflects LRU eviction), not local map size
  const indexedFolderCount = searchableFolderCount

  // Send command to worker
  const send = useCallback((cmd: WorkerCommand, transfer?: Transferable[]) => {
    if (!workerRef.current) return
    if (transfer) {
      workerRef.current.postMessage(cmd, transfer)
    } else {
      workerRef.current.postMessage(cmd)
    }
  }, [])

  // Initialize worker + load from cache on mount
  useEffect(() => {
    const worker = new PSTWorkerConstructor()
    workerRef.current = worker

    worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const msg = e.data
      switch (msg.type) {
        case 'READY':
          setTree(msg.tree)
          setFileName(msg.fileName)
          setFileSize(msg.fileSize)
          setSavedAt(msg.savedAt)
          setLoading(false)
          setLoadingMsg('')
          setProgress(0)
          setLoadingPhase(null)
          setError(null)
          setFolderEmails(new Map())
          setBodyCache(new Map())
          bodyCacheRef.current = new Map()
          setSearchResults(null)
          setSearchableFolderCount(0)
          setFolderTotalCounts(new Map())
          setFolderLoadingPaths(new Set())
          activeSearchRequestIdRef.current = null
          setSearching(false)
          setSearchProgress(null)
          setIndexProgress(null)
          ++indexDoneTimerRef.current // invalidate any pending done-timer
          // Auto-start background indexing of all folders
          worker.postMessage({ type: 'INDEX_ALL' } satisfies WorkerCommand)
          break

        case 'FOLDER_EMAILS':
          setFolderEmails(prev => {
            const next = new Map(prev)
            if (msg.page === 0) {
              next.set(msg.path, msg.emails)
            } else {
              const existing = prev.get(msg.path)
              next.set(msg.path, existing ? [...existing, ...msg.emails] : msg.emails)
            }
            return next
          })
          setSearchableFolderCount(msg.searchableFolderCount)
          setFolderTotalCounts(prev => {
            const next = new Map(prev)
            next.set(msg.path, msg.totalCount)
            return next
          })
          if (msg.page === 0) {
            // Only one folder loads at a time — clear any stuck paths from cancelled loads
            setFolderLoadingPaths(new Set([msg.path]))
          }
          break

        case 'FOLDER_DONE':
          setFolderLoadingPaths(prev => {
            const next = new Set(prev)
            next.delete(msg.path)
            return next
          })
          setFolderTotalCounts(prev => {
            const next = new Map(prev)
            next.set(msg.path, msg.totalCount)
            return next
          })
          break

        case 'EMAIL_BODY':
          setBodyCache(prev => {
            const next = new Map(prev)
            next.set(bodyKey(msg.folderPath, msg.index), { body: msg.body, bodyHTML: msg.bodyHTML })
            // LRU eviction: remove oldest entries if over limit
            if (next.size > MAX_BODY_CACHE) {
              const iter = next.keys()
              while (next.size > MAX_BODY_CACHE) {
                const oldest = iter.next()
                if (oldest.done) break
                next.delete(oldest.value)
              }
            }
            bodyCacheRef.current = next
            return next
          })
          break

        case 'SEARCH_RESULTS':
          if (activeSearchRequestIdRef.current !== msg.requestId) break
          setSearchResults(prev => {
            if (!msg.append) return msg.results
            const existing = prev ?? []
            return existing.length === 0 ? msg.results : [...existing, ...msg.results]
          })
          break

        case 'SEARCH_PROGRESS':
          if (activeSearchRequestIdRef.current !== msg.progress.requestId) break
          setSearchProgress(msg.progress)
          setSearching(!msg.progress.done)
          break

        case 'ATTACHMENT_DATA': {
          const blob = new Blob([msg.data], { type: msg.mimeType })
          const url = URL.createObjectURL(blob)
          const a = document.createElement('a')
          a.href = url
          a.download = msg.fileName
          document.body.appendChild(a)
          a.click()
          document.body.removeChild(a)
          URL.revokeObjectURL(url)
          break
        }

        case 'EML_READY': {
          const blob = new Blob([msg.data], { type: 'message/rfc822' })
          const file = new File([blob], msg.fileName, { type: 'message/rfc822' })
          if (typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] })) {
            navigator.share({ files: [file] }).catch(() => { /* user cancelled */ })
          } else {
            const url = URL.createObjectURL(blob)
            const a = document.createElement('a')
            a.href = url
            a.download = msg.fileName
            document.body.appendChild(a)
            a.click()
            document.body.removeChild(a)
            URL.revokeObjectURL(url)
          }
          break
        }

        case 'EXPORT_READY': {
          setExporting(false)
          setLoadingMsg('')
          // Trigger auto-download
          const blob = new Blob([msg.zipBuffer], { type: 'application/zip' })
          const url = URL.createObjectURL(blob)
          const a = document.createElement('a')
          a.href = url
          a.download = msg.fileName
          document.body.appendChild(a)
          a.click()
          document.body.removeChild(a)
          URL.revokeObjectURL(url)
          break
        }

        case 'PROGRESS':
          setLoadingMsg(msg.message)
          if (msg.percent !== undefined) setProgress(msg.percent)
          setLoadingPhase(msg.phase ?? null)
          break

        case 'ERROR':
          // Empty message = silent signal (e.g. no cache found) — reset loading without showing error
          if (msg.message) setError(msg.message)
          setLoading(false)
          setExporting(false)
          setSearching(false)
          setLoadingMsg('')
          setProgress(0)
          setLoadingPhase(null)
          setIndexProgress(null)
          ++indexDoneTimerRef.current
          break

        case 'INDEX_PROGRESS': {
          const version = ++indexDoneTimerRef.current
          if (msg.done) {
            // Show "done" state briefly, then hide (version-guarded to avoid stale clear)
            setIndexProgress({ indexed: msg.indexed, total: msg.totalFolders })
            setTimeout(() => {
              if (indexDoneTimerRef.current === version) setIndexProgress(null)
            }, 3000)
          } else {
            setIndexProgress({ indexed: msg.indexed, total: msg.totalFolders, paused: msg.paused })
          }
          break
        }

        case 'CACHE_DELETED':
          setTree(null)
          setFileName('')
          setFileSize(0)
          setSavedAt(0)
          setFolderEmails(new Map())
          setBodyCache(new Map())
          bodyCacheRef.current = new Map()
          setSearchResults(null)
          setError(null)
          setProgress(0)
          setLoadingPhase(null)
          setSearchableFolderCount(0)
          setFolderTotalCounts(new Map())
          setFolderLoadingPaths(new Set())
          activeSearchRequestIdRef.current = null
          setSearching(false)
          setSearchProgress(null)
          setIndexProgress(null)
          ++indexDoneTimerRef.current
          break
      }
    }

    worker.onerror = (err) => {
      setError(err.message || 'Worker-Fehler')
      setLoading(false)
    }

    // Auto-load from OPFS cache
    worker.postMessage({ type: 'LOAD_CACHED' } satisfies WorkerCommand)

    return () => {
      worker.terminate()
      workerRef.current = null
    }
  }, [])

  const loadFile = useCallback((file: File) => {
    setLoading(true)
    setLoadingMsg('Datei wird vorbereitet...')
    setProgress(0)
    setLoadingPhase(null)
    setError(null)
    setSearchResults(null)
    activeSearchRequestIdRef.current = null
    setSearching(false)
    setSearchProgress(null)
    setIndexProgress(null)
    ++indexDoneTimerRef.current
    send({ type: 'LOAD_FILE', file })
  }, [send])

  const fetchFolder = useCallback((path: string) => {
    send({ type: 'FETCH_FOLDER', path })
  }, [send])

  const fetchBody = useCallback((folderPath: string, index: number) => {
    // Skip if already cached (use ref to avoid stale closure)
    if (bodyCacheRef.current.has(bodyKey(folderPath, index))) return
    send({ type: 'FETCH_BODY', folderPath, index })
  }, [send])

  const search = useCallback((query: string, folderPath: string, includeBody?: boolean) => {
    const trimmed = query.trim()
    if (!trimmed || !folderPath) {
      send({ type: 'ABORT_SEARCH' })
      activeSearchRequestIdRef.current = null
      setSearching(false)
      setSearchProgress(null)
      setSearchResults(null)
      return
    }

    const requestId = ++searchRequestIdRef.current
    activeSearchRequestIdRef.current = requestId
    setSearching(true)
    setSearchProgress({
      requestId,
      folderPath,
      scanned: 0,
      total: 0,
      matches: 0,
      done: false,
    })
    setSearchResults([])
    setFolderLoadingPaths(new Set())
    send({ type: 'SEARCH', query, folderPath, requestId, includeBody })
  }, [send])

  const abortSearch = useCallback(() => {
    send({ type: 'ABORT_SEARCH' })
    activeSearchRequestIdRef.current = null
    setSearching(false)
    setSearchProgress(prev => prev ? { ...prev, done: true, cancelled: true } : null)
  }, [send])

  const closeFile = useCallback(() => {
    send({ type: 'DELETE_CACHE' })
  }, [send])

  const clearError = useCallback(() => {
    setError(null)
  }, [])

  const exportEmails = useCallback((emails: Array<{ folderPath: string; index: number }>, options: ExportOptions) => {
    setExporting(true)
    setLoadingMsg('Export wird vorbereitet...')
    send({ type: 'EXPORT_EMAILS', emails, options })
  }, [send])

  const exportFolder = useCallback((folderPath: string, options: ExportOptions) => {
    setExporting(true)
    setLoadingMsg('Export wird vorbereitet...')
    send({ type: 'EXPORT_FOLDER', folderPath, options })
  }, [send])

  const fetchAttachment = useCallback((folderPath: string, index: number, attachmentIndex: number) => {
    send({ type: 'FETCH_ATTACHMENT', folderPath, index, attachmentIndex })
  }, [send])

  const shareEmail = useCallback((folderPath: string, index: number) => {
    send({ type: 'BUILD_EML', folderPath, index })
  }, [send])

  const abortLoad = useCallback(() => {
    send({ type: 'ABORT_LOAD' })
  }, [send])

  return {
    tree, fileName, fileSize, savedAt,
    loading, loadingMsg, progress, loadingPhase, error,
    folderEmails, bodyCache, searchResults,
    searching, searchProgress,
    indexedFolderCount,
    folderTotalCounts, folderLoadingPaths,
    exporting,
    indexProgress,
    loadFile, fetchFolder, fetchBody, search, abortSearch, closeFile, clearError, exportEmails, exportFolder, fetchAttachment, shareEmail, abortLoad,
  }
}

export { bodyKey }
