// Per-agent persistence for the chat head's current model (the alias/id shown in
// the composer's model selector).
//
// The model is reported by the CLI's system:init event and "Set model to ..."
// confirmations. Those do not reliably replay on a resume/reconnect, so the
// selector fell back to a "Model" placeholder until a fresh init landed. We
// persist the last-known model so the selector is right immediately.
//
// Two layers back it up: localStorage (instant, same-browser) and the backend
// (AgentResponse.model, so a fresh browser or a teammate gets it too). saveModel
// writes both - localStorage synchronously and the server via a debounced PUT.
// Mirrors planStore; the live stream stays authoritative and corrects the value.

import { api } from '../stores/apiClient'
import { readLocal, writeLocal } from './storage'

function modelKey(projectId: string | null, agentId: string): string {
  return `hydra-model-${projectId ?? '_'}-${agentId}`
}

export function loadModel(projectId: string | null, agentId: string): string {
  return readLocal(modelKey(projectId, agentId)) ?? ''
}

// seedLocalModel primes localStorage from the server-persisted model
// (AgentResponse.model) so a fresh browser - empty localStorage but an agent
// record that carries a model - restores it. It only fills an EMPTY local slot
// (a same-browser value is authoritative and never clobbered) and writes
// localStorage directly WITHOUT a PUT, so seeding never echoes the value back.
// Returns the model it seeded, or '' if it did not seed.
export function seedLocalModel(
  projectId: string | null,
  agentId: string,
  model: string | null | undefined,
): string {
  if (loadModel(projectId, agentId)) return ''
  if (!model) return ''
  writeLocal(modelKey(projectId, agentId), model)
  // Prime lastSent so the next saveModel (once live events flow) doesn't re-PUT
  // an unchanged model back to the server.
  lastSent.set(modelKey(projectId, agentId), model)
  return model
}

// Debounced per-agent PUT queue, and skip PUTs whose payload matches what we
// last sent (a remount re-adopts the same model, which shouldn't re-PUT).
const putTimers = new Map<string, ReturnType<typeof setTimeout>>()
const lastSent = new Map<string, string>()
const PUT_DEBOUNCE_MS = 800

function queueServerPut(projectId: string | null, agentId: string, model: string): void {
  if (!projectId) return
  const k = modelKey(projectId, agentId)
  const existing = putTimers.get(k)
  if (existing) clearTimeout(existing)
  putTimers.set(
    k,
    setTimeout(() => {
      putTimers.delete(k)
      if (lastSent.get(k) === model) return
      lastSent.set(k, model)
      void api.default.setAgentModel(projectId, agentId, { model }).catch(() => {
        // Best-effort: localStorage already holds the model, so a failed PUT just
        // means a fresh browser won't see it until the next successful save.
        lastSent.delete(k)
      })
    }, PUT_DEBOUNCE_MS),
  )
}

// saveModel persists a known model. Empty is ignored (unknown model shouldn't
// clobber a good stored value), so the store only ever holds real models.
export function saveModel(projectId: string | null, agentId: string, model: string): void {
  if (!model) return
  writeLocal(modelKey(projectId, agentId), model)
  queueServerPut(projectId, agentId, model)
}
