// Per-project memory of the last view the user had open — the selected agent,
// the repository browser, or the bare project page — so switching back to a
// project (or reloading the app) restores where you were rather than always
// dropping you on the spawn page. One project-view entry per project.

import { projectViewKey, readJSON, writeJSON } from './storage'

export type ProjectView =
  // The repository `path` is the splat under /repository/ (ref + file path);
  // '' means the repository root.
  | { kind: 'agent'; agentId: string }
  | { kind: 'repository'; path: string }
  | { kind: 'project' }

const PROJECT_ONLY: ProjectView = { kind: 'project' }

function parse(v: unknown): ProjectView | null {
  if (!v || typeof v !== 'object') return null
  const view = v as ProjectView
  if (view.kind === 'agent' && typeof view.agentId === 'string' && view.agentId) return view
  if (view.kind === 'repository' && typeof view.path === 'string') return view
  if (view.kind === 'project') return PROJECT_ONLY
  return null
}

// Load the saved view for a project, defaulting to the bare project page.
export function loadProjectView(projectId: string): ProjectView {
  return readJSON(projectViewKey(projectId), parse) ?? PROJECT_ONLY
}

export function saveProjectView(projectId: string, view: ProjectView): void {
  writeJSON(projectViewKey(projectId), view)
}
