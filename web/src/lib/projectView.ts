// Per-project memory of the last view the user had open — the selected agent,
// the repository browser, or the bare project page — so switching back to a
// project (or reloading the app) restores where you were rather than always
// dropping you on the spawn page.
//
// Supersedes the old `hydra-selected-agent-<projectId>` key, which could only
// remember an agent id and so couldn't represent "the repository was open", nor
// distinguish "deliberately no agent" from "never set". That key is migrated on
// first read, then dropped. One project-view entry per project.

import { projectViewKey, selectedAgentKey, readLocal, writeLocal, readJSON, writeJSON } from './storage'

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
// Migrates a legacy selected-agent entry the first time it's seen.
export function loadProjectView(projectId: string): ProjectView {
  const current = readJSON(projectViewKey(projectId), parse)
  if (current) return current

  const legacyAgentId = readLocal(selectedAgentKey(projectId))
  if (legacyAgentId) {
    const migrated: ProjectView = { kind: 'agent', agentId: legacyAgentId }
    saveProjectView(projectId, migrated)
    writeLocal(selectedAgentKey(projectId), null)
    return migrated
  }
  return PROJECT_ONLY
}

export function saveProjectView(projectId: string, view: ProjectView): void {
  writeJSON(projectViewKey(projectId), view)
}
