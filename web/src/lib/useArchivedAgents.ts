import { useCallback, useEffect, useRef, type RefObject } from 'react'
import { api } from '../stores/apiClient'
import { useAgentStore, ARCHIVED_PAGE_SIZE } from '../stores/agentStore'

// Archived (killed/merged) history list. Loaded lazily and paginated for infinite
// scroll — it is historical, so unlike the live list it is not polled. Resets +
// loads the first page whenever the selected project changes, and loads further
// pages as the returned sentinel scrolls into view. The list itself lives in the
// agent store; this hook owns only the loading lifecycle + the scroll sentinel.
export function useArchivedAgents(currentProjectId: string | null): {
  sentinelRef: RefObject<HTMLDivElement | null>
} {
  const resetArchived = useAgentStore((s) => s.resetArchived)
  const setArchivedLoading = useAgentStore((s) => s.setArchivedLoading)
  const setArchivedFirstPage = useAgentStore((s) => s.setArchivedFirstPage)
  const appendArchived = useAgentStore((s) => s.appendArchived)
  const archivedHasMore = useAgentStore((s) => s.archivedHasMore)
  const archivedLength = useAgentStore((s) => s.archived.length)

  const archivedLoadingRef = useRef(false)
  const sentinelRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    resetArchived()
    if (!currentProjectId) return
    let cancelled = false
    archivedLoadingRef.current = true
    setArchivedLoading(true)
    api.default.listArchivedAgents(currentProjectId, ARCHIVED_PAGE_SIZE, 0)
      .then((page) => { if (!cancelled) setArchivedFirstPage(page) })
      .catch(() => { if (!cancelled) setArchivedLoading(false) })
      .finally(() => { archivedLoadingRef.current = false })
    return () => { cancelled = true }
  }, [currentProjectId, resetArchived, setArchivedLoading, setArchivedFirstPage])

  const loadMoreArchived = useCallback(() => {
    if (!currentProjectId || archivedLoadingRef.current) return
    const { archivedHasMore: hasMore, archived: current } = useAgentStore.getState()
    if (!hasMore) return
    archivedLoadingRef.current = true
    setArchivedLoading(true)
    api.default.listArchivedAgents(currentProjectId, ARCHIVED_PAGE_SIZE, current.length)
      .then((page) => appendArchived(page))
      .catch(() => setArchivedLoading(false))
      .finally(() => { archivedLoadingRef.current = false })
  }, [currentProjectId, setArchivedLoading, appendArchived])

  // Trigger the next archived page when the sentinel scrolls into view.
  useEffect(() => {
    const el = sentinelRef.current
    if (!el || !archivedHasMore) return
    const obs = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) loadMoreArchived()
    }, { rootMargin: '120px' })
    obs.observe(el)
    return () => obs.disconnect()
  }, [archivedHasMore, loadMoreArchived, archivedLength])

  return { sentinelRef }
}
