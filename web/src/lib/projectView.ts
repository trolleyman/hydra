// Per-project memory of the last view the user had open — the selected agent,
// the repository browser, or the bare project page — so switching back to a
// project (or reloading the app) restores where you were rather than always
// dropping you on the spawn page.
//
// Supersedes the old `hydra-selected-agent-<projectId>` key, which could only
// remember an agent id and so couldn't represent "the repository was open", nor
// distinguish "deliberately no agent" from "never set". That key is migrated on
// first read, then dropped. One project-view entry per project.

import { projectViewKey, selectedAgentKey, readLocal, writeLocal } from './storage'

export type ProjectView =
  // The repository `path` is the splat under /repository/ (ref + file path);
  // '' means the repository root.
  | { kind: 'agent'; agentId: string }
  | { kind: 'repository'; path: string }
  | { kind: 'project' }

const PROJECT_ONLY: ProjectView = { kind: 'project' }

function parse(raw: string | null): ProjectView | null {
  if (!raw) return null
  try {
    const v = JSON.parse(raw) as ProjectView
    if (!v || typeof v !== 'object') return null
    if (v.kind === 'agent' && typeof v.agentId === 'string' && v.agentId) return v
    if (v.kind === 'repository' && typeof v.path === 'string') return v
    if (v.kind === 'project') return PROJECT_ONLY
  } catch { /* fall through */ }
  return null
}

// Load the saved view for a project, defaulting to the bare project page.
// Migrates a legacy selected-agent entry the first time it's seen.
export function loadProjectView(projectId: string): ProjectView {
  const current = parse(readLocal(projectViewKey(projectId)))
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
  writeLocal(projectViewKey(projectId), JSON.stringify(view))
}
