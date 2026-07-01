import { create } from 'zustand'

export type ToastType = 'info' | 'success' | 'error' | 'warning'

// Structured payload for a security-gate approval toast. When present on a toast,
// the renderer draws the rich approval card (icon, kind/RW badge, task + target,
// preview block, reason, and the toast's actions) instead of the plain message.
export interface ApprovalToastData {
  // What is being approved: mcp (whole server), mcp_tool (one tool), webfetch, bash.
  kind: string
  // The server name / "server__tool" / host / command the approval is about.
  target: string
  // The requesting agent's title (shown as the subtitle and the quoted task).
  agentName?: string | null
  // Read/write classification for an mcp_tool call ("read"/"write").
  rw?: string | null
  // One-line reason the gate parked the call.
  reason?: string | null
  // webfetch: the full request URL, previewed under the host.
  url?: string | null
  // mcp_tool: a compact one-line preview of the call's arguments.
  argsPreview?: string | null
  // When the requesting agent runs in a DIFFERENT project, its project name — the
  // card shows an amber "running in another project" banner and hides "always allow".
  crossProject?: string | null
}

// An action button rendered inside the toast (e.g. "View" on a needs-input
// toast, or "Allow"/"Deny" on a security-gate toast). onClick receives the
// toast's id so the handler can dismiss it (silently or not) after acting.
export interface ToastAction {
  label: string
  onClick: (toastId: number) => void
  // Visual emphasis: 'primary' (accent), 'danger' (red), or default (neutral).
  variant?: 'primary' | 'danger'
}

export interface Toast {
  id: number
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
  // Optional action buttons rendered alongside the dismiss (X).
  actions?: ToastAction[]
  // Called when the toast is dismissed by the user (the X, or any non-silent
  // dismiss) — but NOT on a silent dismiss. Security-gate toasts use this so
  // that dismissing the toast denies the parked tool call.
  onDismiss?: () => void
  // Optional dedup key. show() replaces the live toast carrying the same key
  // instead of stacking a duplicate (e.g. one approval request → one toast),
  // so repeated polls/StrictMode double-runs don't pile up.
  key?: string
  // When set, the renderer draws the rich security-gate approval card using this
  // structured data (the `message` is then only a fallback for non-approval UIs).
  approval?: ApprovalToastData
}

// How long the leave animation runs before the toast is removed from the list.
// Must match the `toast-out` keyframe duration in index.css.
const EXIT_ANIMATION_MS = 220

interface ToastState {
  toasts: Toast[]
  // Returns the new (or replaced) toast's id, so callers showing a persistent
  // toast (duration: 0) can later dismiss() it — e.g. a "Merging…" indicator.
  show: (options: {
    message: string
    type?: ToastType
    duration?: number
    actions?: ToastAction[]
    onDismiss?: () => void
    key?: string
    approval?: ApprovalToastData
  }) => number
  // silent: skip the toast's onDismiss callback. Used when the toast is being
  // torn down because its action already resolved the underlying request (e.g.
  // "Allow" was clicked, or the gate cleared server-side) — so a deny-on-dismiss
  // toast isn't also denied.
  dismiss: (id: number, opts?: { silent?: boolean }) => void
}

let nextId = 1

export const useToastStore = create<ToastState>((set, get) => ({
  toasts: [],
  show: ({ message, type = 'info', duration = 3000, actions, onDismiss, key, approval }) => {
    // Keyed toast already on screen → replace its contents in place (same id, no
    // re-stack), and re-arm its expiry timer if it auto-dismisses.
    if (key !== undefined) {
      const existing = get().toasts.find((t) => t.key === key && !t.exiting)
      if (existing) {
        set((state) => ({
          toasts: state.toasts.map((t) =>
            t.id === existing.id
              ? { ...t, message, type, duration, actions, onDismiss, approval, createdAt: Date.now() }
              : t,
          ),
        }))
        if (duration > 0) setTimeout(() => get().dismiss(existing.id), duration)
        return existing.id
      }
    }
    const id = nextId++
    set((state) => ({
      toasts: [
        ...state.toasts,
        { id, message, type, duration, createdAt: Date.now(), exiting: false, actions, onDismiss, key, approval },
      ],
    }))
    if (duration > 0) {
      setTimeout(() => get().dismiss(id), duration)
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
    if (!opts?.silent) toast.onDismiss?.()
    set((state) => ({
      toasts: state.toasts.map((t) => (t.id === id ? { ...t, exiting: true } : t)),
    }))
    setTimeout(() => {
      set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) }))
    }, EXIT_ANIMATION_MS)
  },
}))
