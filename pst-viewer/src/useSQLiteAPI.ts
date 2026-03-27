/**
 * useSQLiteAPI — replaces useMultiPSTWorker with a REST API backend
 *
 * Instead of Web Workers + range requests over PST files, this hook
 * calls the Express API endpoints that serve data from SQLite.
 *
 * Exports the same interface as useMultiPSTWorker so App.tsx needs
 * only a one-line import change.
 */

import { useState, useCallback, useEffect, useRef } from 'react'
import type { FolderNode, EmailMeta, SearchResult, SearchProgress, ExportOptions } from './types.ts'
import type { PSTWorkerState, PSTWorkerActions } from './usePSTWorker.ts'

// ── Re-export bodyKey so App.tsx import works ─────────────────────────────────

export function bodyKey(folderPath: string, index: number): string {
  return `${folderPath}\0${index}`
}

// ── Auth header helper ────────────────────────────────────────────────────────

function getAuthHeaders(authHeader?: string): Record<string, string> {
  return authHeader ? { Authorization: authHeader } : {}
}

// ── API → EmailMeta adapter ───────────────────────────────────────────────────

function apiEmailToMeta(e: Record<string, unknown>, folderPath: string): EmailMeta {
  return {
    index: e.id as number,
    folderPath,
    subject: (e.subject as string) || '',
    senderName: (e.sender_name as string) || '',
    senderEmail: (e.sender_email as string) || '',
    displayTo: (e.recipients as string) || '',
    displayCC: (e.recipients_cc as string) || '',
    date: (e.date_sent as string) || null,
    hasAttachments: Boolean(e.has_attachments),
    importance: (e.importance as number) ?? 1,
    isRead: Boolean(e.is_read),
    numberOfAttachments: (e.attachment_count as number) || 0,
    attachmentNames: (() => {
      try { return JSON.parse((e.attachment_names as string) || '[]') } catch { return [] }
    })(),
    bodySnippet: '',
    _searchText: '',
    itemType: (e.item_type as string) === 'email' ? undefined : e.item_type as 'appointment' | 'task' | 'contact' | 'activity',
    location: (e.location as string) || undefined,
    startTime: (e.start_time as string) || undefined,
    endTime: (e.end_time as string) || undefined,
    taskStatus: (e.task_status as number) ?? undefined,
    contactName: (e.contact_name as string) || undefined,
    contactCompany: (e.contact_company as string) || undefined,
    contactPhone: (e.contact_phone as string) || undefined,
  }
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useSQLiteAPI(authHeader?: string): PSTWorkerState & PSTWorkerActions {

  // Persisted auth header ref (avoid stale closures)
  const authHeaderRef = useRef(authHeader ?? '')
  authHeaderRef.current = authHeader ?? ''

  // attachment ID lookup: email SQLite id → attachment id array
  const attachmentIdsRef = useRef<Map<string, number[]>>(new Map())

  // bodyCache ref to avoid stale closures
  const bodyCacheRef = useRef<Map<string, { body: string; bodyHTML: string }>>(new Map())

  // ── State ──────────────────────────────────────────────────────────────────

  const [tree,               setTree]               = useState<FolderNode | null>(null)
  const [loading,            setLoading]            = useState(true)
  const [loadingMsg,         setLoadingMsg]         = useState('Verbinde mit Server…')
  const [progress]                                  = useState(0)
  const [loadingPhase]                              = useState<'copy' | 'parse' | null>(null)
  const [error,              setError]              = useState<string | null>(null)
  const [folderEmails,       setFolderEmails]       = useState<Map<string, EmailMeta[]>>(new Map())
  const [bodyCache,          setBodyCache]          = useState<Map<string, { body: string; bodyHTML: string }>>(new Map())
  const [searchResults,      setSearchResults]      = useState<SearchResult[] | null>(null)
  const [searching,          setSearching]          = useState(false)
  const [searchProgress,     setSearchProgress]     = useState<SearchProgress | null>(null)
  const [folderTotalCounts,  setFolderTotalCounts]  = useState<Map<string, number>>(new Map())
  const [folderLoadingPaths, setFolderLoadingPaths] = useState<Set<string>>(new Set())
  const [exporting,          setExporting]          = useState(false)

  // These are not relevant for the API-based approach but required by the interface
  const fileName = 'PST Archive'
  const fileSize = 0
  const savedAt = 0
  const indexedFolderCount = 0
  const indexProgress: { indexed: number; total: number; paused?: boolean } | null = null

  // ── On mount: check DB and load folder tree ────────────────────────────────

  useEffect(() => {
    let cancelled = false

    async function init() {
      setLoading(true)
      setLoadingMsg('Verbinde mit Server…')
      setError(null)

      try {
        const headers = getAuthHeaders(authHeaderRef.current)

        // Check DB status
        const statusRes = await fetch('/api/db-status', { headers })
        if (!statusRes.ok) throw new Error(`Server error ${statusRes.status}`)
        const status = await statusRes.json() as { ready: boolean; error?: string }

        if (!status.ready) {
          if (!cancelled) {
            setError('Base de données non disponible. Lancez: node scripts/extract.js')
            setLoading(false)
          }
          return
        }

        // Load folder tree
        const foldersRes = await fetch('/api/folders', { headers })
        if (!foldersRes.ok) throw new Error(`Server error ${foldersRes.status}`)
        const folderTree = await foldersRes.json() as FolderNode

        if (!cancelled) {
          setTree(folderTree)
          setLoading(false)
          setLoadingMsg('')
        }
      } catch (err) {
        if (!cancelled) {
          setError(`Cannot connect to server: ${err instanceof Error ? err.message : String(err)}`)
          setLoading(false)
        }
      }
    }

    void init()
    return () => { cancelled = true }
  }, [authHeader])

  // ── fetchFolder ────────────────────────────────────────────────────────────

  const fetchFolder = useCallback(async (canonPath: string) => {
    setFolderLoadingPaths(prev => {
      const next = new Set(prev)
      next.add(canonPath)
      return next
    })

    try {
      const headers = getAuthHeaders(authHeaderRef.current)
      const url = `/api/emails?folder_path=${encodeURIComponent(canonPath)}&limit=2000`
      const res = await fetch(url, { headers })
      if (!res.ok) throw new Error(`Server error ${res.status}`)
      const data = await res.json() as { emails: Record<string, unknown>[]; total: number }

      const metas = data.emails.map(e => apiEmailToMeta(e, canonPath))

      setFolderEmails(prev => {
        const next = new Map(prev)
        next.set(canonPath, metas)
        return next
      })
      setFolderTotalCounts(prev => {
        const next = new Map(prev)
        next.set(canonPath, data.total)
        return next
      })
    } catch (e) {
      console.error('fetchFolder error:', e)
    } finally {
      setFolderLoadingPaths(prev => {
        const next = new Set(prev)
        next.delete(canonPath)
        return next
      })
    }
  }, [])

  // ── fetchBody ──────────────────────────────────────────────────────────────

  const fetchBody = useCallback(async (canonPath: string, emailIndex: number) => {
    const key = bodyKey(canonPath, emailIndex)
    if (bodyCacheRef.current.has(key)) return

    try {
      const headers = getAuthHeaders(authHeaderRef.current)
      const res = await fetch(`/api/email/${emailIndex}`, { headers })
      if (!res.ok) throw new Error(`Server error ${res.status}`)
      const email = await res.json() as Record<string, unknown> & { attachments?: Array<{ id: number }> }

      const entry = {
        body: (email.body_text as string) || '',
        bodyHTML: (email.body_html as string) || '',
      }

      // Store attachment IDs for later use
      if (Array.isArray(email.attachments)) {
        const ids = (email.attachments as Array<{ id: number }>).map(a => a.id)
        attachmentIdsRef.current.set(String(emailIndex), ids)
      }

      bodyCacheRef.current = new Map(bodyCacheRef.current)
      bodyCacheRef.current.set(key, entry)

      setBodyCache(new Map(bodyCacheRef.current))
    } catch (e) {
      console.error('fetchBody error:', e)
    }
  }, [])

  // ── search ─────────────────────────────────────────────────────────────────

  const search = useCallback(async (query: string, canonPath: string, _includeBody?: boolean) => {
    const trimmed = query.trim()
    if (!trimmed || !canonPath) {
      setSearching(false)
      setSearchProgress(null)
      setSearchResults(null)
      return
    }

    setSearching(true)
    setSearchProgress({
      requestId: Date.now(),
      folderPath: canonPath,
      scanned: 0,
      total: 0,
      matches: 0,
      done: false,
    })
    setSearchResults([])

    try {
      const headers = getAuthHeaders(authHeaderRef.current)
      const url = `/api/search?q=${encodeURIComponent(trimmed)}&folder_path=${encodeURIComponent(canonPath)}&limit=500`
      const res = await fetch(url, { headers })
      if (!res.ok) throw new Error(`Server error ${res.status}`)
      const data = await res.json() as { results: Record<string, unknown>[]; total: number }

      const results: SearchResult[] = data.results.map(r => {
        const fp = (r.folder_path as string) || canonPath
        return {
          email: apiEmailToMeta(r, fp),
          folderPath: fp,
          matchField: 'subject',
        }
      })

      setSearchResults(results)
      setSearchProgress({
        requestId: Date.now(),
        folderPath: canonPath,
        scanned: data.total,
        total: data.total,
        matches: results.length,
        done: true,
      })
    } catch (e) {
      console.error('search error:', e)
      setSearchResults([])
    } finally {
      setSearching(false)
    }
  }, [])

  // ── abortSearch ────────────────────────────────────────────────────────────

  const abortSearch = useCallback(() => {
    setSearching(false)
    setSearchProgress(null)
    setSearchResults(null)
  }, [])

  // ── fetchAttachment ────────────────────────────────────────────────────────

  const fetchAttachment = useCallback(async (_canonPath: string, emailIndex: number, attIndex: number) => {
    let ids = attachmentIdsRef.current.get(String(emailIndex))

    // If we don't have the attachment IDs yet, fetch the email first
    if (!ids) {
      try {
        const headers = getAuthHeaders(authHeaderRef.current)
        const res = await fetch(`/api/email/${emailIndex}`, { headers })
        if (res.ok) {
          const email = await res.json() as { attachments?: Array<{ id: number }> }
          if (Array.isArray(email.attachments)) {
            ids = (email.attachments as Array<{ id: number }>).map(a => a.id)
            attachmentIdsRef.current.set(String(emailIndex), ids)
          }
        }
      } catch (e) {
        console.error('fetchAttachment: email fetch error', e)
      }
    }

    if (!ids || attIndex >= ids.length) {
      console.warn('fetchAttachment: attachment not found', { emailIndex, attIndex, ids })
      return
    }

    const attId = ids[attIndex]
    window.open(`/api/attachment/${attId}`, '_blank')
  }, [])

  // ── exportEmails ───────────────────────────────────────────────────────────

  const exportEmails = useCallback(async (
    emails: Array<{ folderPath: string; index: number }>,
    options: ExportOptions
  ) => {
    setExporting(true)
    setLoadingMsg('Export wird vorbereitet…')
    try {
      const headers = {
        ...getAuthHeaders(authHeaderRef.current),
        'Content-Type': 'application/json',
      }
      const body = JSON.stringify({
        email_ids: emails.map(e => e.index),
        include_attachments: options.includeAttachments,
        folder_structure: true,
      })
      const res = await fetch('/api/export', { method: 'POST', headers, body })
      if (!res.ok) throw new Error(`Export error ${res.status}`)

      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      const dateStr = new Date().toISOString().slice(0, 10)
      a.download = `export_${dateStr}.zip`
      a.click()
      URL.revokeObjectURL(url)
    } catch (e) {
      console.error('exportEmails error:', e)
      setError(`Export failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setExporting(false)
      setLoadingMsg('')
    }
  }, [])

  // ── exportFolder ───────────────────────────────────────────────────────────

  const exportFolder = useCallback(async (canonPath: string, options: ExportOptions) => {
    // Fetch all email IDs for the folder (up to 5000)
    try {
      const headers = getAuthHeaders(authHeaderRef.current)
      const res = await fetch(
        `/api/emails?folder_path=${encodeURIComponent(canonPath)}&limit=5000`,
        { headers }
      )
      if (!res.ok) throw new Error(`Server error ${res.status}`)
      const data = await res.json() as { emails: Array<{ id: number }> }
      const emails = data.emails.map(e => ({ folderPath: canonPath, index: e.id as number }))
      await exportEmails(emails, options)
    } catch (e) {
      console.error('exportFolder error:', e)
      setError(`Export failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }, [exportEmails])

  // ── shareEmail ─────────────────────────────────────────────────────────────

  const shareEmail = useCallback((_canonPath: string, emailIndex: number) => {
    window.location.href = `/api/export/eml/${emailIndex}`
  }, [])

  // ── No-ops / simple stubs ──────────────────────────────────────────────────

  const loadFile = useCallback((_file: File) => {
    // Not applicable in API mode
  }, [])

  const closeFile = useCallback(() => {
    setTree(null)
    setFolderEmails(new Map())
    setBodyCache(new Map())
    bodyCacheRef.current = new Map()
    setSearchResults(null)
    setFolderTotalCounts(new Map())
    setFolderLoadingPaths(new Set())
  }, [])

  const clearError = useCallback(() => {
    setError(null)
  }, [])

  const abortLoad = useCallback(() => {
    // Not applicable in API mode
  }, [])

  // ── Return ─────────────────────────────────────────────────────────────────

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
