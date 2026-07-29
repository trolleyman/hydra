import { create } from 'zustand'
import type { ProjectInfo, ReviewConfigResponse, StatusResponse } from '../api'
import { api } from './apiClient'
import { StorageKeys, readJSON, readLocal, writeJSON, writeLocal } from '../lib/storage'
import { deepEqual, reconcileList, reuseIfEqual } from '../lib/deepEqual'

// readStoredReviewConfigs hydrates the persisted per-project review-config
// snapshots (see StorageKeys.reviewConfigs). The endpoint that refreshes them
// is slow (it shells out to gh/glab), so booting from the snapshot lets the
// sidebar forge icon and MR prefill render instantly instead of popping in.
function readStoredReviewConfigs(): Record<string, ReviewConfigResponse> {
  return (
    readJSON<Record<string, ReviewConfigResponse>>(StorageKeys.reviewConfigs, (v) =>
      v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, ReviewConfigResponse>) : null,
    ) ?? {}
  )
}

// applyOrder sorts projects into the order given by `ids`. Projects absent from
// `ids` keep their relative order after the named ones - the same reconciliation
// the server does (projects.Manager.ReorderProjects), so an optimistic local
// order and the order that comes back from the server agree.
function applyOrder(projects: ProjectInfo[], ids: string[]): ProjectInfo[] {
  const rank = new Map(ids.map((id, i) => [id, i]))
  return [...projects].sort(
    (a, b) => (rank.get(a.id) ?? ids.length) - (rank.get(b.id) ?? ids.length),
  )
}

function sameOrder(a: ProjectInfo[], b: ProjectInfo[]): boolean {
  return a.length === b.length && a.every((p, i) => p.id === b[i].id)
}

// applyHidden overlays the hidden flags a toggle just applied locally, and drops
// the ones the server has caught up with (see pendingHidden). Returns the list
// unchanged - same identity - when there is nothing pending, so the common case
// costs nothing.
function applyHidden(
  projects: ProjectInfo[],
  pending: Record<string, boolean>,
): { projects: ProjectInfo[]; pending: Record<string, boolean> } {
  const ids = Object.keys(pending)
  if (ids.length === 0) return { projects, pending }
  const settled = ids.filter((id) => {
    const p = projects.find((x) => x.id === id)
    // A project that vanished (removed elsewhere) settles too - nothing to hold.
    return p == null || !!p.hidden === pending[id]
  })
  const next = settled.length === ids.length ? {} : { ...pending }
  for (const id of settled) delete next[id]
  const remaining = Object.keys(next)
  if (remaining.length === 0) return { projects, pending: next }
  return {
    projects: projects.map((p) => (p.id in next ? { ...p, hidden: next[p.id] } : p)),
    pending: next,
  }
}

interface ProjectState {
  projects: ProjectInfo[]
  // The order a drag-to-reorder just applied locally, held until the server's
  // list comes back in that order. The project list is refetched on every status
  // poll and events-stream nudge, so without this a poll already in flight when
  // the drop happened would land the old order and visibly snap the row back.
  pendingOrder: string[] | null
  // Hidden flags a visibility toggle just applied locally, keyed by project id,
  // held until the server's list agrees - the same "don't let an in-flight poll
  // snap it back" guard as pendingOrder (see applyHidden).
  pendingHidden: Record<string, boolean>
  selectedProjectId: string | null
  systemStatus: StatusResponse | null
  // Resolved [review] config, cached per project. It is project-scoped (not
  // per-agent), so it is fetched once and shared by the Create MR dialog prefill
  // and the Settings editor, rather than re-fetched on every agent view.
  reviewConfigs: Record<string, ReviewConfigResponse>
  setProjects: (projects: ProjectInfo[]) => void
  setProjectOrder: (ids: string[]) => void
  setProjectHiddenLocal: (id: string, hidden: boolean) => void
  setSelectedProjectId: (id: string | null) => void
  setSystemStatus: (status: StatusResponse) => void
  setReviewConfig: (projectId: string, cfg: ReviewConfigResponse) => void
}

export const useProjectStore = create<ProjectState>((set) => ({
  projects: [],
  pendingOrder: null,
  pendingHidden: {},
  selectedProjectId: readLocal(StorageKeys.projectId),
  systemStatus: null,
  reviewConfigs: readStoredReviewConfigs(),
  // The setters below reuse the previous objects when a refetch returns
  // structurally-identical data, so the polls/event-driven refreshes that
  // re-deliver the same state don't re-render every subscriber.
  setProjects: (projects) => set((s) => {
    // Piggyback on the project list to prune persisted review configs of
    // removed projects, so the localStorage snapshot can't grow unbounded.
    const stale = Object.keys(s.reviewConfigs).filter((id) => !projects.some((p) => p.id === id))
    let reviewConfigs = s.reviewConfigs
    if (stale.length > 0) {
      reviewConfigs = { ...s.reviewConfigs }
      for (const id of stale) delete reviewConfigs[id]
      writeJSON(StorageKeys.reviewConfigs, reviewConfigs)
    }
    // While a reorder is in flight, keep showing the order the user dropped
    // things in; drop the override as soon as the server agrees with it.
    const ordered = s.pendingOrder ? applyOrder(projects, s.pendingOrder) : projects
    const pendingOrder = s.pendingOrder && sameOrder(projects, ordered) ? null : s.pendingOrder
    // Same for a hide/show still in flight.
    const withHidden = applyHidden(ordered, s.pendingHidden)
    return {
      projects: reconcileList(s.projects, withHidden.projects, (p) => p.id),
      reviewConfigs,
      pendingOrder,
      pendingHidden: withHidden.pending,
    }
  }),
  setProjectOrder: (ids) => set((s) => ({
    pendingOrder: ids,
    projects: reconcileList(s.projects, applyOrder(s.projects, ids), (p) => p.id),
  })),
  setProjectHiddenLocal: (id, hidden) => set((s) => ({
    pendingHidden: { ...s.pendingHidden, [id]: hidden },
    projects: reconcileList(
      s.projects,
      s.projects.map((p) => (p.id === id ? { ...p, hidden } : p)),
      (p) => p.id,
    ),
  })),
  setSelectedProjectId: (id) => {
    writeLocal(StorageKeys.projectId, id)
    set({ selectedProjectId: id })
  },
  setSystemStatus: (systemStatus) => set((s) => ({ systemStatus: reuseIfEqual(s.systemStatus, systemStatus) })),
  setReviewConfig: (projectId, cfg) => set((s) => {
    if (deepEqual(s.reviewConfigs[projectId], cfg)) return {}
    const reviewConfigs = { ...s.reviewConfigs, [projectId]: cfg }
    writeJSON(StorageKeys.reviewConfigs, reviewConfigs)
    return { reviewConfigs }
  }),
}))

// reorderProjects applies a new project order locally (so the dropdown updates
// under the pointer, with no round trip) and persists it. On failure the
// override is dropped, which lets the next refetch put the server's order back.
export function reorderProjects(ids: string[]): Promise<void> {
  useProjectStore.getState().setProjectOrder(ids)
  return api.default
    .reorderProjects({ project_ids: ids })
    .catch(() => {
      useProjectStore.setState({ pendingOrder: null })
    })
}

// setProjectHidden hides a project from the project lists (or shows it again),
// applying it locally first so the row leaves the list under the pointer. On
// failure the local override is dropped, which lets the next refetch put the
// server's answer back.
export function setProjectHidden(id: string, hidden: boolean): Promise<void> {
  useProjectStore.getState().setProjectHiddenLocal(id, hidden)
  return api.default
    .setProjectHidden(id, { hidden })
    .then(() => {})
    .catch(() => {
      useProjectStore.setState((s) => {
        const pendingHidden = { ...s.pendingHidden }
        delete pendingHidden[id]
        return {
          pendingHidden,
          projects: s.projects.map((p) => (p.id === id ? { ...p, hidden: !hidden } : p)),
        }
      })
    })
}

// visibleProjects drops the projects the user has hidden, keeping the one that
// is currently selected: a hidden project you are *looking at* still has to be
// in the list its own picker renders, or the picker would show nothing selected.
// Everything that lists projects to switch between goes through this - the
// dropdown (outside its edit mode, which is where hiding is done and so must
// show everything) and the Ctrl+` switcher.
export function visibleProjects(projects: ProjectInfo[], selectedId: string | null): ProjectInfo[] {
  if (!projects.some((p) => p.hidden)) return projects // keep list identity stable
  return projects.filter((p) => !p.hidden || p.id === selectedId)
}

// expandOrder folds the projects that aren't on screen (the hidden ones - see
// visibleProjects) back into an order the user just dragged, anchoring each to
// the visible project it currently sits behind. `all` is the full list in its
// current order, `visibleIds` the rendered rows in their new one.
export function expandOrder(all: ProjectInfo[], visibleIds: string[]): string[] {
  if (all.length === visibleIds.length) return visibleIds
  const shown = new Set(visibleIds)
  // Hidden projects ahead of the first visible one have nothing to anchor to and
  // simply stay at the front.
  const lead: string[] = []
  const trailing = new Map<string, string[]>()
  let anchor: string | null = null
  for (const p of all) {
    if (shown.has(p.id)) {
      anchor = p.id
    } else if (anchor == null) {
      lead.push(p.id)
    } else {
      const ids = trailing.get(anchor) ?? []
      ids.push(p.id)
      trailing.set(anchor, ids)
    }
  }
  return [...lead, ...visibleIds.flatMap((id) => [id, ...(trailing.get(id) ?? [])])]
}

// One in-flight GET per project, shared by every consumer (root layout, agent
// page, settings Review section): simultaneous cold mounts - including
// StrictMode's dev double-mount - join the same request instead of each firing
// their own. The endpoint is slow (~600ms; the server shells out to gh/glab
// for auth status), so stray duplicates are very visible in the request log.
const reviewConfigFetches = new Map<string, Promise<void>>()

// Projects whose review config was fetched from the server this session. A
// localStorage-hydrated entry renders immediately but still counts as stale -
// ensureReviewConfig kicks one background refresh per project per session so
// the snapshot tracks config/auth changes.
const freshReviewConfigs = new Set<string>()

// ensureReviewConfig loads a project's resolved review config into the store
// cache; a no-op when it was already fetched this session or a fetch is in
// flight. With a persisted snapshot present the store already has data, so
// consumers render instantly while this refresh runs.
export function ensureReviewConfig(projectId: string): Promise<void> {
  if (freshReviewConfigs.has(projectId)) return Promise.resolve()
  return refreshReviewConfig(projectId)
}

// The server answers GetReviewConfig without waiting on the gh/glab auth-status
// shell-out: a response with `authenticated` absent means the check is still
// running in the background. Poll a few times until it lands so the Create MR
// dialog warning and the Settings auth row settle; capped so a server that can
// never resolve auth doesn't get polled forever.
const authPollAttempts = new Map<string, number>()
const AUTH_POLL_MAX = 5
const AUTH_POLL_INTERVAL_MS = 2000

function scheduleAuthPoll(projectId: string, cfg: ReviewConfigResponse): void {
  const pending = cfg.provider && cfg.auth === 'cli' && cfg.authenticated == null
  if (!pending) {
    authPollAttempts.delete(projectId)
    return
  }
  const attempts = authPollAttempts.get(projectId) ?? 0
  if (attempts >= AUTH_POLL_MAX) return
  authPollAttempts.set(projectId, attempts + 1)
  setTimeout(() => void refreshReviewConfig(projectId), AUTH_POLL_INTERVAL_MS)
}

// refreshReviewConfig re-fetches even when cached (still joining any in-flight
// fetch), for callers that want fresh values - opening the Create MR dialog,
// saving settings. Failures are swallowed: a previously-cached config stays put.
export function refreshReviewConfig(projectId: string): Promise<void> {
  const running = reviewConfigFetches.get(projectId)
  if (running) return running
  const request = api.default
    .getReviewConfig(projectId)
    .then((cfg) => {
      freshReviewConfigs.add(projectId)
      useProjectStore.getState().setReviewConfig(projectId, cfg)
      scheduleAuthPoll(projectId, cfg)
    })
    .catch(() => {})
    .finally(() => reviewConfigFetches.delete(projectId))
  reviewConfigFetches.set(projectId, request)
  return request
}
