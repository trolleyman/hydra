import { create } from 'zustand'
import { createContext, type ReactNode } from 'react'

export type ToastType = 'info' | 'success' | 'error' | 'warning'

// A toast's body content. A plain string renders as the message paragraph (with
// `backtick` spans as inline branch pills). Any other ReactNode renders verbatim,
// so rich toasts (e.g. the agent-transition row from lib/agentToast) are just a
// node passed through `message` - no per-variant field on the store. Content that
// needs to close its own toast (e.g. a link that navigates then dismisses) reads
// the bound dismiss from ToastDismissContext rather than threading the id around.
export type ToastContent = ReactNode

// Bound to each live toast's dismiss by the renderer, so rich `message` content
// can tear its own toast down (default is a no-op for content shown elsewhere).
export const ToastDismissContext = createContext<() => void>(() => {})

// Accent override for a toast's icon tile + countdown bar. Omitted, both follow
// the toast `type` (blue for info, green for success, ...). Set it when a toast
// wants an identity off the type palette - e.g. the emerald "merge queued" card.
export interface ToastAccent {
  // Tailwind classes for the 9x9 icon tile (bg + text), e.g. the emerald tint.
  wrap: string
  // Tailwind class for the countdown bar fill, e.g. 'bg-emerald-500'.
  bar: string
}

// Structured payload for a security-gate approval toast. When present on a toast,
// the renderer draws the rich approval card (icon, kind/RW badge, task + target,
// preview block, reason, and the toast's actions) instead of the plain message.
export interface ApprovalToastData {
  // What is being approved: mcp (whole server), mcp_tool (one tool), webfetch,
  // egress, bash, tool (a tool the gate doesn't recognize), or host_command (run
  // a command on the host, outside the sandbox), or filesystem_read (mount one
  // host file or directory read-only).
  kind: string
  // The server name / "server__tool" / host / command the approval is about (for
  // host_command, the full command text, shown verbatim in the card).
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
  // host_command: the agent's own explanation of what it is asking for and why it
  // has to happen outside the sandbox (`hydra host-run --why`), shown above the
  // command so the user judges a stated intent rather than a bare shell script.
  description?: string | null
  // When the requesting agent runs in a DIFFERENT project, its project name - the
  // card shows an amber "running in another project" banner and hides "always allow".
  crossProject?: string | null
}

// Project context for a plain toast whose work belongs to a specific project
// (e.g. a sync started for project A). The renderer draws the neutral project
// header ONLY while a DIFFERENT project is in view - so the toast reads as "this
// is happening over in project A" once you switch away, and stays header-less
// while you are still looking at the project it ran for.
export interface ToastProjectContext {
  projectId: string
  projectName: string
  // The project's custom icon string (the same value the project switcher uses),
  // resolved to the switcher's ProjectIcon in the header. Omit for the folder.
  icon?: string | null
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
  // The toast body. A string renders as the message paragraph (`backtick` spans
  // become inline mono branch pills); a ReactNode from pillText is the same
  // sentence with untrusted text spliced in, and renders in that paragraph too.
  message: ToastContent
  // Set when `message` is a multi-row LAYOUT of its own (the agent-transition
  // card) rather than a sentence. A sentence gets the prose paragraph and is
  // centred against the icon tile; a layout gets neither and tops out with it.
  // A flag rather than a `typeof message === 'string'` test, because a sentence
  // is no longer always a string - see pillText in lib/branchPills.
  richMessage?: boolean
  // Tile glyph override (a lucide icon element). Omitted, the tile shows the
  // `type` icon; rich toasts pass e.g. <Bot/> to identify as an agent.
  icon?: ReactNode
  // Icon-tile + countdown-bar accent override; omitted, both follow `type`.
  accent?: ToastAccent
  // Optional raw technical detail (a JSON error body, a stack trace) rendered
  // verbatim in a monospace code block under the message - so code-like error
  // text reads as code instead of being run into the headline sentence.
  code?: string
  // Language tag for the `code` block (e.g. 'json'), shown as a small label and
  // mirroring a fenced ```<lang> block. Omit for an untagged (plain) block.
  codeLang?: string
  // Tightens the card's padding, icon tile and type scale. For toasts that are a
  // glance-and-gone acknowledgement rather than something to read - a copy
  // confirmation is the whole reason this exists: at the standard size, a
  // two-word title over a one-line value sat in a card that was mostly padding.
  compact?: boolean
  // Widen this card out of the shared notification column. Only for content with
  // a real measured width requirement - see TOAST_CARD_WIDTH_WIDE.
  wide?: boolean
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
  // When set, a plain toast can show a neutral project header - but the renderer
  // only draws it while a DIFFERENT project is in view (see ToastProjectContext).
  projectContext?: ToastProjectContext
}

// Default lifetimes when a caller doesn't pass an explicit `duration`. An error
// toast sticks around markedly longer than a success/info one: it usually carries
// detail worth reading (an HTTP status, a JSON body) and, unlike a confirmation,
// it is the only record of what went wrong once it fades.
const DEFAULT_DURATION_MS = 3000
const ERROR_DURATION_MS = 10000

// How long the leave animation runs before the toast is removed from the list.
// Must match the `toast-out` keyframe duration in index.css.
const EXIT_ANIMATION_MS = 220

interface ToastState {
  toasts: Toast[]
  // Returns the new (or replaced) toast's id, so callers showing a persistent
  // toast (duration: 0) can later dismiss() it - e.g. a "Merging..." indicator.
  show: (options: {
    message: ToastContent
    richMessage?: boolean
    code?: string
    codeLang?: string
    compact?: boolean
    wide?: boolean
    type?: ToastType
    // Lifetime in ms; 0 = persistent. Omitted, it defaults by type (errors get
    // the longer ERROR_DURATION_MS, everything else DEFAULT_DURATION_MS).
    duration?: number
    actions?: ToastAction[]
    onDismiss?: () => void
    key?: string
    icon?: ReactNode
    accent?: ToastAccent
    approval?: ApprovalToastData
    projectContext?: ToastProjectContext
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
  show: ({ message, richMessage, code, codeLang, compact, wide, type = 'info', duration = type === 'error' ? ERROR_DURATION_MS : DEFAULT_DURATION_MS, actions, onDismiss, key, icon, accent, approval, projectContext }) => {
    // Keyed toast already on screen → replace its contents in place (same id, no
    // re-stack), and re-arm its expiry timer if it auto-dismisses.
    if (key !== undefined) {
      const existing = get().toasts.find((t) => t.key === key && !t.exiting)
      if (existing) {
        set((state) => ({
          toasts: state.toasts.map((t) =>
            t.id === existing.id
              ? { ...t, message, richMessage, code, codeLang, compact, wide, type, duration, actions, onDismiss, icon, accent, approval, projectContext, createdAt: Date.now() }
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
        { id, message, richMessage, code, codeLang, compact, wide, type, duration, createdAt: Date.now(), exiting: false, actions, onDismiss, key, icon, accent, approval, projectContext },
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
