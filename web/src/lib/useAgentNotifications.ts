import { useEffect, useRef } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useAgentStore } from '../stores/agentStore'
import { useProjectStore } from '../stores/projectStore'
import { useToastStore } from '../stores/toastStore'
import { api } from '../stores/apiClient'
import { runWithToast } from './apiAction'
import type { ApprovalRequest } from '../api'
import { ApprovalDecisionRequest } from '../api'

// "Needs input" toasts linger noticeably longer than the 3s default — they ask
// the user to act, so they should stay put while you finish the current thought.
const NEEDS_INPUT_TOAST_MS = 12_000
// "Finished" is informational rather than blocking, so it auto-dismisses sooner
// than a needs-input nudge but still slower than the generic 3s toast.
const FINISHED_TOAST_MS = 8_000

// useAgentNotifications watches the live agent list for the current project and
// surfaces three kinds of toasts:
//
//   1. State-transition toasts — when an agent crosses into `needs_input` (and
//      isn't a security-gate wait, which gets its own toast below) or `finished`,
//      a toast pops with a "View" button that jumps to the agent.
//   2. Security-gate approval toasts — for each parked tool call (MCP / WebFetch
//      / bash), a persistent toast with Allow / Deny actions. Dismissing the
//      toast (X) denies the call; "Allow" tears it down silently.
//   3. Cross-project needs-input toasts — agent-level detail is only loaded for
//      the selected project, but the daemon broadcasts every project's
//      `needs_input_count`. When a *background* project's count rises, a toast
//      names that project and offers a "View project" button that switches to it.
//
// Transitions are detected by diffing each agent's status against the previous
// poll; a first-seen agent never toasts (so a page load / project switch where
// an agent is *already* needs_input/finished stays quiet).
export function useAgentNotifications(currentProjectId: string | null) {
  const navigate = useNavigate()
  const agents = useAgentStore((s) => s.agents)
  const agentsProjectId = useAgentStore((s) => s.agentsProjectId)
  const projects = useProjectStore((s) => s.projects)

  // projectId → last-observed needs_input_count, for cross-project rise detection.
  const lastNeedsInput = useRef<Map<string, number>>(new Map())

  // agentId → last-observed status, for transition detection.
  const lastStatus = useRef<Map<string, string>>(new Map())
  // agentId → reqid → toast id, so a resolved/withdrawn approval can dismiss the
  // matching toast (silently) without denying it.
  const approvalToasts = useRef<Map<string, Map<string, number>>>(new Map())
  // agentId → status timestamp we last fetched approvals for, so we only refetch
  // when the gate bumps the timestamp (a new park / a resolution).
  const approvalStamp = useRef<Map<string, string>>(new Map())

  useEffect(() => {
    // The store's agent list belongs to `agentsProjectId`; ignore runs where it
    // hasn't caught up to the route's project yet, to avoid cross-project toasts.
    if (!currentProjectId || agentsProjectId !== currentProjectId) return

    const toast = useToastStore.getState()

    // --- 1. needs_input / finished transition toasts ---
    const prev = lastStatus.current
    const next = new Map<string, string>()
    for (const agent of agents) {
      const status = agent.agent_status?.status
      if (!status) continue
      next.set(agent.id, status)
      const before = prev.get(agent.id)
      if (before === undefined || before === status) continue

      const notifType = agent.agent_status?.notification_type
      const name = agent.title || agent.id
      if (status === 'needs_input' && notifType !== 'policy_approval') {
        toast.show({
          message: `"${name}" needs your input`,
          type: 'warning',
          duration: NEEDS_INPUT_TOAST_MS,
          actions: [
            {
              label: 'View',
              variant: 'primary',
              onClick: (toastId) => {
                navigate({ to: '/project/$projectId/agent/$agentId', params: { projectId: currentProjectId, agentId: agent.id } })
                toast.dismiss(toastId)
              },
            },
          ],
        })
      } else if (status === 'finished') {
        toast.show({
          message: `"${name}" finished`,
          type: 'success',
          duration: FINISHED_TOAST_MS,
          actions: [
            {
              label: 'View',
              variant: 'primary',
              onClick: (toastId) => {
                navigate({ to: '/project/$projectId/agent/$agentId', params: { projectId: currentProjectId, agentId: agent.id } })
                toast.dismiss(toastId)
              },
            },
          ],
        })
      }
    }
    lastStatus.current = next

    // --- 2. security-gate approval toasts ---
    const decide = async (agentId: string, reqid: string, decision: ApprovalDecisionRequest.decision, remember: boolean) => {
      await runWithToast(
        () => api.default.decideAgentApproval(currentProjectId, agentId, reqid, { decision, remember }),
        { errorPrefix: decision === ApprovalDecisionRequest.decision.ALLOW ? 'Failed to allow request' : 'Failed to deny request' },
      )
    }

    // Drop tracked toasts for agents that have left the approval wait (or the
    // list). They resolved elsewhere, so tear them down silently (no deny).
    const approvalAgentIds = new Set(
      agents.filter((a) => a.agent_status?.notification_type === 'policy_approval').map((a) => a.id),
    )
    for (const [agentId, reqMap] of approvalToasts.current) {
      if (approvalAgentIds.has(agentId)) continue
      for (const toastId of reqMap.values()) toast.dismiss(toastId, { silent: true })
      approvalToasts.current.delete(agentId)
      approvalStamp.current.delete(agentId)
    }

    // For each agent waiting on the gate, fetch its parked calls when the status
    // timestamp has changed since we last looked, then reconcile toasts.
    for (const agent of agents) {
      if (agent.agent_status?.notification_type !== 'policy_approval') continue
      const stamp = agent.agent_status?.timestamp ?? ''
      if (approvalStamp.current.get(agent.id) === stamp) continue
      approvalStamp.current.set(agent.id, stamp)

      const agentId = agent.id
      const agentName = agent.title || agent.id
      void (async () => {
        let approvals: ApprovalRequest[]
        try {
          approvals = (await api.default.listAgentApprovals(currentProjectId, agentId)).approvals ?? []
        } catch {
          // Leave existing toasts in place; a later stamp bump will retry.
          return
        }
        let reqMap = approvalToasts.current.get(agentId)
        if (!reqMap) {
          reqMap = new Map()
          approvalToasts.current.set(agentId, reqMap)
        }
        const liveReqids = new Set(approvals.map((a) => a.reqid))
        // Withdrawn requests (gone from the fetch) → silent teardown.
        for (const [reqid, toastId] of reqMap) {
          if (liveReqids.has(reqid)) continue
          toast.dismiss(toastId, { silent: true })
          reqMap.delete(reqid)
        }
        // Surface every parked call as a persistent Allow/Deny toast. The `key`
        // dedups so a repeat fetch (or StrictMode double-run) reuses the toast.
        for (const a of approvals) {
          const canRemember = a.kind === 'mcp' || a.kind === 'webfetch'
          const actions = [
            {
              label: 'Allow once',
              variant: 'primary' as const,
              onClick: (toastId: number) => {
                void decide(agentId, a.reqid, ApprovalDecisionRequest.decision.ALLOW, false)
                reqMap!.delete(a.reqid)
                toast.dismiss(toastId, { silent: true })
              },
            },
            ...(canRemember
              ? [
                  {
                    label: 'Always allow',
                    variant: 'primary' as const,
                    onClick: (toastId: number) => {
                      void decide(agentId, a.reqid, ApprovalDecisionRequest.decision.ALLOW, true)
                      reqMap!.delete(a.reqid)
                      toast.dismiss(toastId, { silent: true })
                    },
                  },
                ]
              : []),
            {
              label: 'Deny',
              variant: 'danger' as const,
              onClick: (toastId: number) => toast.dismiss(toastId),
            },
          ]
          const id = toast.show({
            message: `Security gate — "${agentName}" ${a.summary}${a.reason ? ` (${a.reason})` : ''}`,
            type: 'warning',
            duration: 0,
            key: `approval:${agentId}:${a.reqid}`,
            actions,
            // X / Deny / any non-silent dismiss denies the parked call.
            onDismiss: () => {
              reqMap!.delete(a.reqid)
              void decide(agentId, a.reqid, ApprovalDecisionRequest.decision.DENY, false)
            },
          })
          reqMap.set(a.reqid, id)
        }
      })()
    }
  }, [agents, agentsProjectId, currentProjectId, navigate])

  // Cross-project needs-input toasts. We only have per-project counts for
  // background projects (no agent-level detail), so we diff each project's
  // needs_input_count and toast when a *non-current* project's count rises. The
  // current project is handled agent-by-agent above, so it's recorded but never
  // toasted here. First-seen counts are recorded silently (no toast on load).
  useEffect(() => {
    const toast = useToastStore.getState()
    const prev = lastNeedsInput.current
    const next = new Map<string, number>()
    for (const p of projects) {
      const count = p.needs_input_count ?? 0
      next.set(p.id, count)
      const before = prev.get(p.id)
      if (p.id === currentProjectId) continue
      if (before === undefined || count <= before) continue
      const name = p.name || p.path || p.id
      toast.show({
        // A dedup key so a project whose count keeps climbing reuses one toast
        // rather than stacking a new one on every bump.
        key: `project-needs-input:${p.id}`,
        message: `Another project — "${name}" has ${count === 1 ? 'an agent that needs' : `${count} agents that need`} your input`,
        type: 'warning',
        duration: NEEDS_INPUT_TOAST_MS,
        actions: [
          {
            label: 'View project',
            variant: 'primary',
            onClick: (toastId) => {
              useProjectStore.getState().setSelectedProjectId(p.id)
              navigate({ to: '/project/$projectId', params: { projectId: p.id } })
              toast.dismiss(toastId)
            },
          },
        ],
      })
    }
    lastNeedsInput.current = next
  }, [projects, currentProjectId, navigate])
}
