// Per-agent persistence for the chat plan / to-do list.
//
// The plan is reconstructed from the Task*/TodoWrite events in the replay
// window. Once that window slides past the creates, the reconstruction is empty
// or partial - so a navigate-away-and-back showed no plan. We persist the keyed
// task entries here (keyed by the real "#N" id where known) so the panel can be
// restored on mount and live TaskUpdates still find their target.

import { readLocal, writeLocal } from './storage'

export interface PlanEntry {
  // Map key: the real "#N" id for Task* tasks, or a synthetic key for TodoWrite.
  key: string
  content: string
  status: 'pending' | 'in_progress' | 'completed'
  activeForm?: string
  description?: string
  order: number
}

function planKey(projectId: string | null, agentId: string): string {
  return `hydra-plan-${projectId ?? '_'}-${agentId}`
}

export function loadPlan(projectId: string | null, agentId: string): PlanEntry[] {
  try {
    const raw = readLocal(planKey(projectId, agentId))
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as PlanEntry[]) : []
  } catch {
    return []
  }
}

export function savePlan(projectId: string | null, agentId: string, entries: PlanEntry[]): void {
  writeLocal(planKey(projectId, agentId), entries.length ? JSON.stringify(entries) : null)
}
