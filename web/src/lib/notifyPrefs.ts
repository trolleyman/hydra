// Desktop (browser) notification preference + the low-level "fire one
// notification" helper.
//
// Hydra already surfaces agent transitions (needs_input / approval / finished)
// as in-app toasts and a dot in the tab title, but those only help while the tab
// is in front. This adds an *out-of-tab* channel: the browser Notification API,
// which the OS shows even when the Hydra tab is backgrounded or unfocused (as
// long as the tab is still open - a fully closed tab would need a service worker
// + Web Push, which is deliberately out of scope here).
//
// The preference is a client-only, global localStorage flag (mirrors the theme /
// terminal-rows prefs), owned by a zustand store so the Settings toggle and the
// notification-firing hook stay in sync. It carries the live OS permission state
// too, because "enabled" only means something once the browser has granted
// permission - and the browser only grants that from a user gesture, which the
// Settings toggle provides.

import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { StorageKeys, readLocal, writeLocal, singleFieldStorage } from './storage'

// The browser's Notification.permission, plus a synthetic 'unsupported' for
// environments without the API at all (some mobile/embedded webviews).
export type NotifyPermission = NotificationPermission | 'unsupported'

export function notificationsSupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window
}

// The live OS permission for this origin (re-read on demand; the user can change
// it in browser settings behind our back).
export function currentPermission(): NotifyPermission {
  if (!notificationsSupported()) return 'unsupported'
  return Notification.permission
}

// Exported for unit testing. The stored value is a bare '1' flag (see storage.ts).
export function loadNotifyEnabled(): boolean {
  return readLocal(StorageKeys.desktopNotifications) === '1'
}

interface NotifyState {
  // The user's opt-in preference (persisted). Firing additionally requires the OS
  // permission to be 'granted' - see `permission`.
  enabled: boolean
  // Live OS permission, mirrored into the store so the UI can explain a blocked /
  // not-yet-granted state instead of silently doing nothing.
  permission: NotifyPermission
  // Toggle the preference. Turning it ON requests the OS permission when it hasn't
  // been decided yet (this must be called from a user gesture for the browser to
  // show its prompt); the resulting `enabled` sticks only if permission is granted.
  setEnabled: (enabled: boolean) => Promise<void>
  // Re-sync `permission` from the browser (e.g. after the user changed it in site
  // settings, or on tab focus).
  refreshPermission: () => void
}

// persist owns read-on-init + write-on-set; singleFieldStorage keeps the stored
// value as the bare '1' flag under the existing key (not persist's JSON envelope),
// matching the theme store's approach.
export const useNotifyStore = create<NotifyState>()(
  persist(
    (set) => ({
      enabled: loadNotifyEnabled(),
      permission: currentPermission(),
      setEnabled: async (enabled) => {
        if (!enabled) {
          set({ enabled: false })
          return
        }
        if (!notificationsSupported()) {
          set({ enabled: false, permission: 'unsupported' })
          return
        }
        let perm = Notification.permission
        if (perm === 'default') {
          try {
            perm = await Notification.requestPermission()
          } catch {
            perm = Notification.permission
          }
        }
        // Only actually enable if the browser said yes; a denied prompt leaves the
        // toggle off with the permission recorded so the UI can explain why.
        set({ permission: perm, enabled: perm === 'granted' })
      },
      refreshPermission: () => set({ permission: currentPermission() }),
    }),
    {
      name: StorageKeys.desktopNotifications,
      storage: singleFieldStorage<'enabled', boolean>('enabled', loadNotifyEnabled, (enabled) =>
        writeLocal(StorageKeys.desktopNotifications, enabled ? '1' : null),
      ),
      partialize: (s) => ({ enabled: s.enabled }),
    },
  ),
)

// fireNotification shows one OS notification, if the user has opted in and the
// browser has granted permission. Callers gate on visibility themselves (we only
// want these while the tab is NOT in front - a focused tab already gets the toast).
//
// `tag` coalesces: a second notification with the same tag replaces the first in
// the OS tray rather than stacking, so a re-fire for the same agent/approval
// doesn't pile up. `sticky` (requireInteraction) keeps blocking prompts on screen
// until dismissed; informational "finished" notes auto-expire.
export function fireNotification(opts: {
  title: string
  body: string
  tag: string
  sticky: boolean
  onClick: () => void
}): void {
  const { enabled, permission } = useNotifyStore.getState()
  if (!enabled || permission !== 'granted' || !notificationsSupported()) return
  let n: Notification
  try {
    n = new Notification(opts.title, { body: opts.body, tag: opts.tag, requireInteraction: opts.sticky })
  } catch {
    // Some browsers only allow construction via a service worker; degrade silently.
    return
  }
  n.onclick = () => {
    try {
      window.focus()
    } catch {
      // ignore - focusing is best-effort
    }
    n.close()
    opts.onClick()
  }
}
