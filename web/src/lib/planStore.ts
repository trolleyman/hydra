// Per-agent persistence for the chat plan / to-do list.
//
// The daemon owns the durable copy: it tracks Task*/TodoWrite events on the
// live stream (claudestream.PlanTracker), persists every change to the agent
// record, and hands the current list to the chat in a "plan" WS frame on
// attach - so the plan survives with no browser watching. This module keeps
// the lightweight client-side layer around that: a localStorage copy for an
// instant panel restore on mount (before the WS connects), seeded from the
// server's AgentResponse.plan when local is empty, and replaced whenever a
// "plan" frame is adopted.

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

function parseEntries(raw: string | null | undefined): PlanEntry[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as PlanEntry[]) : []
  } catch {
    return []
  }
}

// parseServerPlan turns a server plan JSON string (AgentResponse.plan or a
// chat "plan" frame) into plan entries.
export function parseServerPlan(planJSON: string | null | undefined): PlanEntry[] {
  return parseEntries(planJSON)
}

export function loadPlan(projectId: string | null, agentId: string): PlanEntry[] {
  return parseEntries(readLocal(planKey(projectId, agentId)))
}

// seedLocalPlan primes localStorage from the server-persisted plan
// (AgentResponse.plan) so a fresh browser - which has an empty localStorage but
// whose agent record carries a plan - restores it before the chat WS delivers
// the authoritative "plan" frame. It only fills an EMPTY local slot. Returns
// the entries it seeded, or [] if it did not seed.
export function seedLocalPlan(
  projectId: string | null,
  agentId: string,
  planJSON: string | null | undefined,
): PlanEntry[] {
  if (loadPlan(projectId, agentId).length) return []
  const entries = parseEntries(planJSON)
  if (!entries.length) return []
  writeLocal(planKey(projectId, agentId), JSON.stringify(entries))
  return entries
}

// savePlan stores the panel's current entries locally (the durable copy lives
// on the server, maintained by the daemon's stream tracking).
export function savePlan(projectId: string | null, agentId: string, entries: PlanEntry[]): void {
  writeLocal(planKey(projectId, agentId), entries.length ? JSON.stringify(entries) : null)
}
