// Per-project memory of the last view the user had open - the selected agent, a
// file in the repository browser, the project's settings page - so switching
// back to a project (or reloading the app) restores where you were rather than
// always dropping you on the spawn page. One project-view entry per project.
//
// What is stored is the URL suffix under /project/<id> (path + search + hash),
// not an enumerated "kind": whatever the router can address is remembered
// verbatim, including a deep repository file, a compare-diff selection and its
// line anchor. Restoring parses that suffix back into one of the known routes
// (parseProjectView, used by __root's navigateToProjectView) so we only ever
// navigate somewhere real - an unrecognised suffix (a route that has since been
// removed, hand-edited storage) falls back to the bare project page.

import { projectViewKey, readJSON, writeJSON } from './storage'

// The remembered suffix for the bare project page.
export const PROJECT_HOME = ''

// A remembered suffix parsed back into the route it addresses. `repository`
// carries the decoded splat (ref + file path; '' is the repository root), the
// compare-diff search params and the line-anchor hash (without its '#').
export type ProjectViewRoute =
  | { kind: 'project' }
  | { kind: 'settings' }
  | { kind: 'agent'; agentId: string }
  | { kind: 'repository'; path: string; compare?: string; dfile?: string; hash?: string }

const PROJECT_ONLY: ProjectViewRoute = { kind: 'project' }

// Stored shape. Legacy entries are the pre-suffix discriminated union
// ({ kind: 'agent' | 'repository' | 'project' }) and are migrated on read.
type Stored = { view: string }

type LegacyView =
  | { kind: 'agent'; agentId: string }
  | { kind: 'repository'; path: string }
  | { kind: 'project' }

function fromLegacy(v: LegacyView): string | null {
  if (v.kind === 'agent' && typeof v.agentId === 'string' && v.agentId) {
    return `/agent/${encodeURIComponent(v.agentId)}`
  }
  if (v.kind === 'repository' && typeof v.path === 'string') {
    return v.path ? `/repository/${v.path}` : '/repository'
  }
  if (v.kind === 'project') return PROJECT_HOME
  return null
}

function parse(v: unknown): string | null {
  if (!v || typeof v !== 'object') return null
  const stored = v as Stored & LegacyView
  if (typeof stored.view === 'string') return stored.view
  if (typeof stored.kind === 'string') return fromLegacy(stored)
  return null
}

// Load the saved view suffix for a project, defaulting to the bare project page.
export function loadProjectView(projectId: string): string {
  return readJSON(projectViewKey(projectId), parse) ?? PROJECT_HOME
}

export function saveProjectView(projectId: string, view: string): void {
  writeJSON(projectViewKey(projectId), { view } satisfies Stored)
}

// Forget a project's remembered view, so the next switch into it lands on the
// project page. Used when the remembered view turns out to be dead (an agent
// that no longer exists - see the agent route).
export function resetProjectView(projectId: string): void {
  saveProjectView(projectId, PROJECT_HOME)
}

// Split a router href ("/project/<id>/agent/x?y#z") into the project it belongs
// to and the suffix to remember for it. Returns null for any non-project
// location ("/", "/settings"), which has no per-project memory.
//
// The whole location is parsed as one string on purpose: deriving the project id
// from route params while taking the path from the location lets the two
// disagree mid-navigation (params lag the location by a render), which used to
// persist the *new* project's path under the *old* project's id - wiping the
// memory of the project being switched away from.
export function splitProjectHref(href: string): { projectId: string; view: string } | null {
  const m = /^\/project\/([^/?#]+)([/?#].*)?$/.exec(href)
  if (!m) return null
  const projectId = decode(m[1])
  if (!projectId) return null
  const view = m[2] ?? PROJECT_HOME
  return { projectId, view: view === '/' ? PROJECT_HOME : view }
}

// Parse a remembered suffix into the route it addresses.
export function parseProjectView(view: string): ProjectViewRoute {
  const hashAt = view.indexOf('#')
  // Without the leading '#': that is the form router navigation expects (it adds
  // the '#' itself).
  const hash = hashAt >= 0 ? view.slice(hashAt + 1) : ''
  const withoutHash = hashAt >= 0 ? view.slice(0, hashAt) : view
  const queryAt = withoutHash.indexOf('?')
  const query = queryAt >= 0 ? withoutHash.slice(queryAt + 1) : ''
  const path = queryAt >= 0 ? withoutHash.slice(0, queryAt) : withoutHash

  if (path === PROJECT_HOME || path === '/') return PROJECT_ONLY
  if (path === '/settings') return { kind: 'settings' }

  const agent = /^\/agent\/([^/]+)$/.exec(path)
  if (agent) {
    const agentId = decode(agent[1])
    return agentId ? { kind: 'agent', agentId } : PROJECT_ONLY
  }

  if (path === '/repository' || path === '/repository/' || path.startsWith('/repository/')) {
    const raw = path.startsWith('/repository/') ? path.slice('/repository/'.length) : ''
    const splat = decode(raw)
    if (splat == null) return PROJECT_ONLY
    const params = new URLSearchParams(query)
    const compare = params.get('compare') || undefined
    const dfile = params.get('dfile') || undefined
    return { kind: 'repository', path: splat, compare, dfile, hash: hash || undefined }
  }

  return PROJECT_ONLY
}

// decodeURIComponent that yields null on a malformed escape rather than throwing
// (stored suffixes can be hand-edited, and a stray '%' must not break routing).
function decode(s: string): string | null {
  try {
    return decodeURIComponent(s)
  } catch {
    return null
  }
}
