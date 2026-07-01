import { useToastStore, type ToastType, type ApprovalToastData, type AgentTransitionToastData } from '../stores/toastStore'
import { StorageKeys } from './storage'

// Spec for a harness-driven toast. Mirrors the real toast shape but with action
// buttons reduced to label + variant (no onClick) — the screenshot harness only
// needs them rendered, not wired, and functions can't cross the page.evaluate
// boundary anyway.
interface HarnessToastSpec {
  message: string
  type?: ToastType
  duration?: number
  actions?: { label: string; variant?: 'primary' | 'danger' }[]
  // When set, the rich security-gate approval card is rendered.
  approval?: ApprovalToastData
  // When set, the "<agent> transitioned to <status>" row is rendered.
  agentTransition?: AgentTransitionToastData
}

// installToastHarness exposes a tiny hook on window for driving the toast store
// from page context (used by the screenshot script to capture transient toasts
// deterministically). It is a NO-OP unless the harness localStorage flag is set,
// which only the screenshot script seeds — so real builds never expose it.
//
// It is deliberately not gated on import.meta.env.DEV: the screenshots run a
// production `vite build`, so a DEV gate would strip it from exactly the build
// that needs it. The localStorage flag is the gate instead.
export function installToastHarness() {
  try {
    if (localStorage.getItem(StorageKeys.toastHarness) !== '1') return
  } catch {
    return // localStorage unavailable (e.g. blocked) — nothing to do.
  }
  ;(window as unknown as { __hydraToast?: unknown }).__hydraToast = {
    // Clear every live toast, so a shot starts from a clean canvas regardless of
    // any toasts the app fired on load.
    reset: () => useToastStore.setState({ toasts: [] }),
    show: (spec: HarnessToastSpec) =>
      useToastStore.getState().show({
        message: spec.message,
        type: spec.type,
        duration: spec.duration ?? 0,
        actions: spec.actions?.map((a) => ({ label: a.label, variant: a.variant, onClick: () => {} })),
        approval: spec.approval,
        agentTransition: spec.agentTransition,
      }),
  }
}
