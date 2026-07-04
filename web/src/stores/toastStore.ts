import { create } from 'zustand'

export type ToastType = 'info' | 'success' | 'error' | 'warning'

// Structured payload for a security-gate approval toast. When present on a toast,
// the renderer draws the rich approval card (icon, kind/RW badge, task + target,
// preview block, reason, and the toast's actions) instead of the plain message.
export interface ApprovalToastData {
  // What is being approved: mcp (whole server), mcp_tool (one tool), webfetch,
  // egress, bash, or tool (a tool the gate doesn't recognize).
  kind: string
  // The server name / "server__tool" / host / command the approval is about.
  target: string
  // The requesting agent's title (shown as the clickable subtitle).
  agentName?: string | null
  // The requesting agent's id + project, so the subtitle can link through to it.
  agentId?: string | null
  projectId?: string | null
  // Read/write classification for an mcp_tool call ("read"/"write").
  rw?: string | null
  // One-line reason the gate parked the call.
  reason?: string | null
  // webfetch: the full request URL, previewed under the host.
  url?: string | null
  // mcp_tool: a compact one-line preview of the call's arguments.
  argsPreview?: string | null
  // When the requesting agent runs in a DIFFERENT project, its project name - the
  // card shows an amber "running in another project" banner and hides "always allow".
  crossProject?: string | null
}

// Structured payload for an agent status-transition toast (an agent crossing
// into needs_input / finished) - also reused by the merge-lifecycle toasts
// (queued / merging / merged), which want the same visual identity. The renderer
// draws a "<bot> <agent> <before> <status pill> <after>" row whose agent label
// links through to the agent - so there's no separate "View" button.
export interface AgentTransitionToastData {
  // The agent's title (the clickable label) + where it lives (for the link).
  agentName: string
  agentId: string
  projectId: string
  // The status rendered as the standard status pill (also 'merged', which only
  // exists as a pill on these toasts). Omit it for a text-only row.
  status?: string
  // Icon-tile override: 'merge-queued' swaps the bot for the emerald Clock the
  // armed merge pill / queue-merge button use. Defaults to the bot.
  icon?: 'merge-queued'
  // Copy before the pill. Defaults to 'transitioned to'; pass '' to lead with
  // the pill ("[merging] into `main`..."). Like `message`, `backtick` spans render
  // as inline mono branch pills.
  before?: string
  // Copy after the pill, e.g. the merge target ("into `main`").
  after?: string
  // Set when the agent runs in a DIFFERENT project than the one in view - shown
  // as the neutral (gray) folder-icon project banner across the card's top,
  // the calm sibling of the approval card's amber one.
  projectName?: string | null
}

// An action button rendered inside the toast (e.g. "Allow"/"Deny" on a
// security-gate toast). onClick receives the toast's id so the handler can
// dismiss it (silently or not) after acting.
export interface ToastAction {
  label: string
  onClick: (toastId: number) => void
  // Visual emphasis: 'primary' (accent), 'danger' (red), or default (neutral).
  variant?: 'primary' | 'danger'
}

export interface Toast {
  id: number
  // The toast copy. `backtick` spans render as inline mono branch pills
  // ("Synced with `origin/main`"); unpaired backticks stay literal.
  message: string
  type: ToastType
  // Total lifetime in ms before the toast auto-dismisses. 0 = persistent (the
  // caller dismisses it manually). Kept on the toast so the renderer can drive
  // the expiry countdown bar from it.
  duration: number
  // Wall-clock time the toast was shown, so the renderer can compute how much of
  // the lifetime remains if it ever mounts late (e.g. a re-render mid-life).
  createdAt: number
  // True once the toast is animating out. It lingers in the list for one exit
  // animation before being removed, so the leave transition can play.
  exiting: boolean
  // True while the pointer is hovering the toast: the auto-dismiss timer is
  // suspended and the countdown bar frozen, so a toast can be read/acted on
  // without expiring under the cursor. Only meaningful for duration > 0 toasts.
  paused?: boolean
  // Optional action buttons rendered alongside the dismiss (X).
  actions?: ToastAction[]
  // Called when the toast is dismissed by the user (the X, or any non-silent
  // dismiss) - but NOT on a silent dismiss. Security-gate toasts use this so
  // that dismissing the toast denies the parked tool call.
  onDismiss?: () => void
  // Optional dedup key. show() replaces the live toast carrying the same key
  // instead of stacking a duplicate (e.g. one approval request → one toast),
  // so repeated polls/StrictMode double-runs don't pile up.
  key?: string
  // When set, the renderer draws the rich security-gate approval card using this
  // structured data (the `message` is then only a fallback for non-approval UIs).
  approval?: ApprovalToastData
  // When set, the renderer draws the "<agent> transitioned to <status>" row
  // (the `message` is then only a fallback for non-visual surfaces).
  agentTransition?: AgentTransitionToastData
}

// How long the leave animation runs before the toast is removed from the list.
// Must match the `toast-out` keyframe duration in index.css.
const EXIT_ANIMATION_MS = 220

interface ToastState {
  toasts: Toast[]
  // Returns the new (or replaced) toast's id, so callers showing a persistent
  // toast (duration: 0) can later dismiss() it - e.g. a "Merging..." indicator.
  show: (options: {
    message: string
    type?: ToastType
    duration?: number
    actions?: ToastAction[]
    onDismiss?: () => void
    key?: string
    approval?: ApprovalToastData
    agentTransition?: AgentTransitionToastData
  }) => number
  // silent: skip the toast's onDismiss callback. Used when the toast is being
  // torn down because its action already resolved the underlying request (e.g.
  // "Allow" was clicked, or the gate cleared server-side) - so a deny-on-dismiss
  // toast isn't also denied.
  dismiss: (id: number, opts?: { silent?: boolean }) => void
  // Suspend a toast's auto-dismiss timer (on pointer enter). Captures how much
  // lifetime was left so resume() can re-arm from there. No-op for persistent
  // (duration 0) or already-paused/exiting toasts.
  pause: (id: number) => void
  // Re-arm a paused toast's timer with the remaining lifetime (on pointer leave).
  resume: (id: number) => void
}

let nextId = 1

// Live auto-dismiss timers, keyed by toast id, kept out of the store's state so
// arming/clearing one doesn't trigger a re-render. `timeoutId` is null while a
// toast is paused; `remaining`/`startedAt` track how much lifetime is left so a
// paused timer can resume from where it stopped.
interface ToastTimer {
  timeoutId: ReturnType<typeof setTimeout> | null
  remaining: number
  startedAt: number
}
const timers = new Map<number, ToastTimer>()

// armTimer (re)starts the countdown for a toast, clearing any prior timer for the
// same id first (e.g. a keyed toast replaced in place).
function armTimer(id: number, ms: number, expire: (id: number) => void) {
  clearTimer(id)
  timers.set(id, {
    remaining: ms,
    startedAt: Date.now(),
    timeoutId: setTimeout(() => {
      timers.delete(id)
      expire(id)
    }, ms),
  })
}

// clearTimer cancels and forgets a toast's timer, if any.
function clearTimer(id: number) {
  const t = timers.get(id)
  if (t?.timeoutId != null) clearTimeout(t.timeoutId)
  timers.delete(id)
}

export const useToastStore = create<ToastState>((set, get) => ({
  toasts: [],
  show: ({ message, type = 'info', duration = 3000, actions, onDismiss, key, approval, agentTransition }) => {
    // Keyed toast already on screen → replace its contents in place (same id, no
    // re-stack), and re-arm its expiry timer if it auto-dismisses.
    if (key !== undefined) {
      const existing = get().toasts.find((t) => t.key === key && !t.exiting)
      if (existing) {
        set((state) => ({
          toasts: state.toasts.map((t) =>
            t.id === existing.id
              ? { ...t, message, type, duration, actions, onDismiss, approval, agentTransition, createdAt: Date.now() }
              : t,
          ),
        }))
        if (duration > 0) armTimer(existing.id, duration, (i) => get().dismiss(i))
        return existing.id
      }
    }
    const id = nextId++
    set((state) => ({
      toasts: [
        ...state.toasts,
        { id, message, type, duration, createdAt: Date.now(), exiting: false, actions, onDismiss, key, approval, agentTransition },
      ],
    }))
    if (duration > 0) {
      armTimer(id, duration, (i) => get().dismiss(i))
    }
    return id
  },
  // dismiss plays the leave animation: flag the toast `exiting` (so the renderer
  // swaps to the out transition and drops its countdown bar), then remove it once
  // the animation has run. Guarded so a double dismiss (timer + click) is a no-op.
  // Fires onDismiss first unless this is a silent teardown.
  dismiss: (id, opts) => {
    const toast = get().toasts.find((t) => t.id === id)
    if (!toast || toast.exiting) return
    clearTimer(id)
    if (!opts?.silent) toast.onDismiss?.()
    set((state) => ({
      toasts: state.toasts.map((t) => (t.id === id ? { ...t, exiting: true } : t)),
    }))
    setTimeout(() => {
      set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) }))
    }, EXIT_ANIMATION_MS)
  },
  pause: (id) => {
    const t = timers.get(id)
    if (!t || t.timeoutId == null) return // no live timer, or already paused
    clearTimeout(t.timeoutId)
    const remaining = Math.max(0, t.remaining - (Date.now() - t.startedAt))
    timers.set(id, { timeoutId: null, remaining, startedAt: Date.now() })
    set((state) => ({
      toasts: state.toasts.map((t2) => (t2.id === id ? { ...t2, paused: true } : t2)),
    }))
  },
  resume: (id) => {
    const t = timers.get(id)
    if (!t || t.timeoutId != null) return // no paused timer to resume
    armTimer(id, t.remaining, (i) => get().dismiss(i))
    set((state) => ({
      toasts: state.toasts.map((t2) => (t2.id === id ? { ...t2, paused: false } : t2)),
    }))
  },
}))
