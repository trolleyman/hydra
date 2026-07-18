// Per-agent persistence for the chat plan / to-do list.
//
// The plan is reconstructed from the Task*/TodoWrite events in the replay
// window. Once that window slides past the creates, the reconstruction is empty
// or partial - so a navigate-away-and-back showed no plan. We persist the keyed
// task entries so the panel can be restored on mount and live TaskUpdates still
// find their target.
//
// Two layers back it up: localStorage (instant, same-browser) and the backend
// (AgentResponse.plan, so a fresh browser or a teammate gets it too). savePlan
// writes both - localStorage synchronously and the server via a debounced PUT.
// The daemon is a third, authoritative source: on chat attach it reconstructs
// the plan from the FULL transcript (claudestream.ReconstructPlan) and sends it
// in a "plan" frame, which the chat adopts over whatever these layers held -
// covering heads that ran with no browser watching.

import { api } from '../stores/apiClient'
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

// parseServerPlan turns an AgentResponse.plan JSON string into plan entries.
export function parseServerPlan(planJSON: string | null | undefined): PlanEntry[] {
  return parseEntries(planJSON)
}

export function loadPlan(projectId: string | null, agentId: string): PlanEntry[] {
  return parseEntries(readLocal(planKey(projectId, agentId)))
}

// seedLocalPlan primes localStorage from the server-persisted plan
// (AgentResponse.plan) so a fresh browser - which has an empty localStorage but
// whose agent record carries a plan - restores it. It only fills an EMPTY local
// slot (a same-browser plan is authoritative and never clobbered) and writes
// localStorage directly WITHOUT a PUT, so seeding never echoes the server value
// straight back. Returns the entries it seeded, or [] if it did not seed.
export function seedLocalPlan(
  projectId: string | null,
  agentId: string,
  planJSON: string | null | undefined,
): PlanEntry[] {
  if (loadPlan(projectId, agentId).length) return []
  const entries = parseEntries(planJSON)
  if (!entries.length) return []
  const json = JSON.stringify(entries)
  writeLocal(planKey(projectId, agentId), json)
  // Prime lastSent so the next savePlan (once live events flow) doesn't re-PUT
  // an unchanged plan back to the server.
  lastSent.set(planKey(projectId, agentId), json)
  return entries
}

// markPlanSynced records that the server already holds exactly `entries` (it
// just sent them in a chat "plan" frame), so the savePlan that follows an
// adopt doesn't PUT the server's own plan straight back at it.
export function markPlanSynced(projectId: string | null, agentId: string, entries: PlanEntry[]): void {
  lastSent.set(planKey(projectId, agentId), entries.length ? JSON.stringify(entries) : '')
}

// Debounced per-agent PUT queue. Coalesces bursts of savePlan calls (a plan gets
// rewritten on every TaskUpdate) into one request per agent, and skips PUTs whose
// payload matches what we last sent.
const putTimers = new Map<string, ReturnType<typeof setTimeout>>()
const lastSent = new Map<string, string>()
const PUT_DEBOUNCE_MS = 800

function queueServerPut(projectId: string | null, agentId: string, plan: string): void {
  if (!projectId) return
  const k = planKey(projectId, agentId)
  const existing = putTimers.get(k)
  if (existing) clearTimeout(existing)
  putTimers.set(
    k,
    setTimeout(() => {
      putTimers.delete(k)
      if (lastSent.get(k) === plan) return
      lastSent.set(k, plan)
      void api.default.setAgentPlan(projectId, agentId, { plan }).catch(() => {
        // Best-effort: localStorage already holds the plan, so a failed PUT just
        // means a fresh browser won't see it until the next successful save.
        lastSent.delete(k)
      })
    }, PUT_DEBOUNCE_MS),
  )
}

export function savePlan(projectId: string | null, agentId: string, entries: PlanEntry[]): void {
  const json = entries.length ? JSON.stringify(entries) : ''
  writeLocal(planKey(projectId, agentId), json || null)
  queueServerPut(projectId, agentId, json)
}
