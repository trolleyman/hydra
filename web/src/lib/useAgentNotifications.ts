import { useCallback, useEffect, useRef } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useAgentStore } from '../stores/agentStore'
import { useProjectStore } from '../stores/projectStore'
import { useToastStore } from '../stores/toastStore'
import { api } from '../stores/apiClient'
import { runWithToast } from './apiAction'
import { fireNotification } from './notifyPrefs'
import type { AgentResponse, ApprovalRequest } from '../api'
import { ApprovalDecisionRequest } from '../api'

// "Needs input" toasts linger noticeably longer than the 3s default - they ask
// the user to act, so they should stay put while you finish the current thought.
const NEEDS_INPUT_TOAST_MS = 12_000
// "Finished" is informational rather than blocking, so it auto-dismisses sooner
// than a needs-input nudge but still slower than the generic 3s toast.
const FINISHED_TOAST_MS = 8_000

// useAgentNotifications watches the live agent list for the current project and
// surfaces three kinds of toasts:
//
//   1. State-transition toasts - when an agent crosses into `needs_input` (and
//      isn't a security-gate wait, which gets its own toast below) or `finished`,
//      a toast pops with a "View" button that jumps to the agent.
//   2. Security-gate approval toasts - for each parked tool call (MCP / WebFetch
//      / bash) or blocked egress host, a persistent toast with Allow / Deny
//      actions. Dismissing the toast (X) denies the call; "Allow" tears it down
//      silently.
//   3. Cross-project status toasts - the daemon broadcasts every project's
//      `needs_input_count` and `unread_count`, so when a *background* project's
//      counts change we fetch that project's agents on demand, and pop one toast
//      per agent that newly blocked on input, finished, or went idle ("Agent X
//      in project Y transitioned to ...") whose agent label switches to it. The
//      toast carries the neutral project banner naming where it happened.
//
// Transitions are detected by diffing each agent's status against the previous
// poll; a first-seen agent never toasts (so a page load / project switch where
// an agent is *already* needs_input/finished stays quiet).
//
// Each toast-worthy transition ALSO fires a desktop (OS) notification when the
// tab is not in front (`!pageActive`) and the user has opted in - the toast only
// helps while you're looking at the page, so the out-of-tab channel covers the
// backgrounded/unfocused case. A focused tab gets the toast only (no redundant
// OS notification). See lib/notifyPrefs.
export function useAgentNotifications(currentProjectId: string | null, pageActive: boolean) {
  const agents = useAgentStore((s) => s.agents)
  const agentsProjectId = useAgentStore((s) => s.agentsProjectId)
  const projects = useProjectStore((s) => s.projects)
  const navigate = useNavigate()

  // Open an agent from an OS-notification click: select its project first (a
  // no-op for the current one), then route to it. Mirrors the toast's "View".
  // Memoised so it's a stable effect dependency.
  const openAgent = useCallback(
    (projectId: string, agentId: string) => {
      useProjectStore.getState().setSelectedProjectId(projectId)
      void navigate({ to: '/project/$projectId/agent/$agentId', params: { projectId, agentId } })
    },
    [navigate],
  )

  // projectId → last-observed (needs_input_count, unread_count), for
  // cross-project change detection.
  const lastBgCounts = useRef<Map<string, { needsInput: number; unread: number }>>(new Map())
  // projectId → set of needs_input agent ids last seen for a background project,
  // so an on-demand refetch only toasts agents that newly entered the wait.
  const bgBlocked = useRef<Map<string, Set<string>>>(new Map())
  // projectId → set of unread agent ids last seen for a background project -
  // the finished/waiting analogue of bgBlocked. The daemon raises an agent's
  // unread flag when it settles into a state worth telling the user about
  // (finished/waiting ride out a grace window first, so subagent blips don't
  // count), which makes "newly unread" the transition signal.
  const bgUnread = useRef<Map<string, Set<string>>>(new Map())
  // When this hook first observed the project list (set on the effect's first
  // run - render must stay pure). An unread finished/waiting agent only toasts
  // if its status transition happened while the UI was open (small slack for
  // the unread grace window) - the first count change for a project toasts
  // every not-yet-seen unread agent, which would otherwise include agents that
  // finished days ago and were simply never read.
  const mountedAt = useRef<number | null>(null)

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
          message: `"${name}" transitioned to needs input`,
          type: 'warning',
          duration: NEEDS_INPUT_TOAST_MS,
          agentTransition: { agentName: name, agentId: agent.id, projectId: currentProjectId, status },
        })
        if (!pageActive) {
          fireNotification({
            title: `${name} needs input`,
            body: 'The agent is blocked waiting on you.',
            tag: `needs-input:${agent.id}`,
            sticky: true,
            onClick: () => openAgent(currentProjectId, agent.id),
          })
        }
      } else if (status === 'finished') {
        toast.show({
          message: `"${name}" transitioned to finished`,
          type: 'success',
          duration: FINISHED_TOAST_MS,
          agentTransition: { agentName: name, agentId: agent.id, projectId: currentProjectId, status },
        })
        if (!pageActive) {
          fireNotification({
            title: `${name} finished`,
            body: 'The agent has completed its task.',
            tag: `finished:${agent.id}`,
            sticky: false,
            onClick: () => openAgent(currentProjectId, agent.id),
          })
        }
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
          // Notify only for a call we haven't already surfaced, so a re-fetch of
          // the same still-parked request doesn't re-alert.
          const isNewApproval = !reqMap.has(a.reqid)
          // mcp / mcp_tool / webfetch / egress persist an "always allow"; bash
          // (e.g. git push) and tool (an unrecognized tool - the permanent fix is
          // registering it in Hydra's known-tools list, not a per-call grant) are
          // one-shot only.
          const canRemember = a.kind === 'mcp' || a.kind === 'mcp_tool' || a.kind === 'webfetch' || a.kind === 'egress'
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
            // message is a fallback for non-card surfaces; the card renders `approval`.
            message: `Agent "${agentName}" ${a.summary}`,
            type: 'warning',
            duration: 0,
            key: `approval:${agentId}:${a.reqid}`,
            actions,
            approval: {
              kind: a.kind,
              target: a.target,
              agentName,
              agentId,
              projectId: currentProjectId,
              rw: a.rw,
              reason: a.reason,
              url: a.url,
              argsPreview: a.args_preview,
            },
            // X / Deny / any non-silent dismiss denies the parked call.
            onDismiss: () => {
              reqMap!.delete(a.reqid)
              void decide(agentId, a.reqid, ApprovalDecisionRequest.decision.DENY, false)
            },
          })
          reqMap.set(a.reqid, id)
          if (isNewApproval && !pageActive) {
            fireNotification({
              title: `${agentName} needs approval`,
              body: a.summary,
              tag: `approval:${agentId}:${a.reqid}`,
              sticky: true,
              onClick: () => openAgent(currentProjectId, agentId),
            })
          }
        }
      })()
    }
  }, [agents, agentsProjectId, currentProjectId, pageActive, openAgent])

  // Cross-project status toasts. The agent list is only loaded for the selected
  // project (handled agent-by-agent above), but the daemon broadcasts every
  // project's needs_input_count and unread_count. So we diff each *background*
  // project's counts and, when either changes, fetch that project's agents on
  // demand to learn which ones moved - popping one toast per newly-blocked
  // agent (needs_input) and one per newly-unread finished/waiting agent. A
  // first-seen count pair is recorded silently (no toast / fetch on load).
  useEffect(() => {
    mountedAt.current ??= Date.now()
    const observedSince = mountedAt.current
    const toast = useToastStore.getState()
    const prev = lastBgCounts.current
    const next = new Map<string, { needsInput: number; unread: number }>()
    for (const p of projects) {
      const counts = { needsInput: p.needs_input_count ?? 0, unread: p.unread_count ?? 0 }
      next.set(p.id, counts)
      if (p.id === currentProjectId) continue
      const before = prev.get(p.id)
      if (before === undefined || (counts.needsInput === before.needsInput && counts.unread === before.unread)) continue

      const pid = p.id
      const projectName = p.name || p.path || p.id
      void (async () => {
        let projectAgents: AgentResponse[]
        try {
          projectAgents = await api.default.listAgents(pid)
        } catch {
          return // transient; a later count change retries.
        }
        const blocked = projectAgents.filter((a) => a.agent_status?.status === 'needs_input')
        const blockedIds = new Set(blocked.map((a) => a.id))
        const seenBlocked = bgBlocked.current.get(pid) ?? new Set<string>()
        for (const a of blocked) {
          if (seenBlocked.has(a.id)) continue // already toasted for this agent.
          const agentName = a.title || a.id
          toast.show({
            // One toast per agent (no plural copy); the key dedups a re-fetch.
            key: `bg-needs-input:${a.id}`,
            message: `Agent "${agentName}" in project "${projectName}" transitioned to needs input`,
            type: 'warning',
            duration: NEEDS_INPUT_TOAST_MS,
            // Cross-project: the label still links through (its onClick selects the
            // project first), and projectName draws the cross-project banner.
            agentTransition: { agentName, agentId: a.id, projectId: pid, status: 'needs_input', projectName },
          })
          if (!pageActive) {
            fireNotification({
              title: `${agentName} needs input`,
              body: `In project "${projectName}" - the agent is blocked waiting on you.`,
              tag: `needs-input:${a.id}`,
              sticky: true,
              onClick: () => openAgent(pid, a.id),
            })
          }
        }
        // Record the current blocked set so an agent that unblocks then blocks
        // again later re-toasts, while still-blocked agents don't.
        bgBlocked.current.set(pid, blockedIds)

        // Finished/waiting: toast agents whose unread flag newly appeared.
        // needs_input also raises unread but is covered (immediately, without
        // the grace delay) by the blocked diff above, so it's skipped here.
        const unread = projectAgents.filter((a) => a.has_unread_changes)
        const seenUnread = bgUnread.current.get(pid) ?? new Set<string>()
        for (const a of unread) {
          if (seenUnread.has(a.id)) continue // already toasted (or pre-dates us).
          const status = a.agent_status?.status
          if (status !== 'finished' && status !== 'waiting') continue
          // Only transitions that happened while this UI was open (60s slack
          // covers the daemon's grace window between the transition timestamp
          // and the unread flag being raised).
          const at = Date.parse(a.agent_status?.timestamp ?? '')
          if (Number.isNaN(at) || at < observedSince - 60_000) continue
          const agentName = a.title || a.id
          toast.show({
            key: `bg-${status}:${a.id}`,
            message: `Agent "${agentName}" in project "${projectName}" transitioned to ${status === 'finished' ? 'finished' : 'waiting'}`,
            type: status === 'finished' ? 'success' : 'info',
            duration: FINISHED_TOAST_MS,
            agentTransition: { agentName, agentId: a.id, projectId: pid, status, projectName },
          })
          // Desktop notification for finished only (waiting is a soft idle nudge
          // the user opted out of).
          if (status === 'finished' && !pageActive) {
            fireNotification({
              title: `${agentName} finished`,
              body: `In project "${projectName}" - the agent has completed its task.`,
              tag: `finished:${a.id}`,
              sticky: false,
              onClick: () => openAgent(pid, a.id),
            })
          }
        }
        // Record every currently-unread agent (whatever its status), so a flag
        // that clears (the user reads it) and is later re-raised re-toasts,
        // while still-unread agents don't repeat.
        bgUnread.current.set(pid, new Set(unread.map((a) => a.id)))
      })()
    }
    lastBgCounts.current = next
  }, [projects, currentProjectId, pageActive, openAgent])
}
