import { create } from 'zustand'
import type { ApprovalRequest } from '../api'

// The parked security-gate requests, per head, as last read from the daemon.
//
// useAgentNotifications already polls them to drive the approval TOASTS; this
// store is where it publishes what it saw, so a second surface can render the
// same pending request without a second poller. Today that surface is the chat
// transcript, which grows Allow/Deny buttons on the very tool card the head is
// blocked in (see ToolApproval in AgentChat) - the toast is the "you're looking
// somewhere else" channel, the card is the in-context one.
//
// Both surfaces act through the same decide() path, so whichever one you use,
// the other tears down: the store drops the request immediately (resolve), and
// the toast is dismissed by its `approval:<agentId>:<reqid>` key.
interface ApprovalState {
  // agentId -> the requests currently parked for that head ([] once none are).
  pending: Record<string, ApprovalRequest[]>
  // Replace a head's parked set (called after each listAgentApprovals fetch).
  setPending: (agentId: string, approvals: ApprovalRequest[]) => void
  // Drop one request the moment it is decided, so the card/buttons disappear
  // without waiting for the next poll.
  resolve: (agentId: string, reqid: string) => void
  // Forget a head entirely (it was killed/merged away).
  clear: (agentId: string) => void
}

// sameReqids avoids a store update (and the re-render of every tool card) when a
// poll returns the same still-parked set it did last tick.
function sameReqids(a: ApprovalRequest[] | undefined, b: ApprovalRequest[]): boolean {
  if (!a || a.length !== b.length) return false
  return a.every((r, i) => r.reqid === b[i].reqid)
}

export const useApprovalStore = create<ApprovalState>((set, get) => ({
  pending: {},
  setPending: (agentId, approvals) => {
    const current = get().pending[agentId]
    if (sameReqids(current, approvals)) return
    if (approvals.length === 0 && current === undefined) return
    set((s) => ({ pending: { ...s.pending, [agentId]: approvals } }))
  },
  resolve: (agentId, reqid) => {
    const current = get().pending[agentId]
    if (!current?.some((r) => r.reqid === reqid)) return
    set((s) => ({ pending: { ...s.pending, [agentId]: current.filter((r) => r.reqid !== reqid) } }))
  },
  clear: (agentId) => {
    if (get().pending[agentId] === undefined) return
    set((s) => {
      const pending = { ...s.pending }
      delete pending[agentId]
      return { pending }
    })
  },
}))
