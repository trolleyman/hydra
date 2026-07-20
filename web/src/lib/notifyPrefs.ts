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
import { DEFAULT_ICON_URL } from './projectIconUrl'

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

// Live OS notifications we've fired, keyed by tag. The Notification API's only
// handle to an already-shown notification is the object its constructor returned
// (there's no "close by tag"), so we hold those references here - a later state
// change (the agent left needs_input, its unread changes were read, an approval
// was withdrawn) can then retract the matching prompt instead of leaving it in
// the OS tray. A tag maps to at most one entry; re-firing a tag replaces it (the
// OS coalesces by tag, so only the newest is actually on screen).
interface LiveNotification {
  n: Notification
  // Auto-dismiss timer, if the caller asked for one (see fireNotification).
  timer?: ReturnType<typeof setTimeout>
}
const liveNotifications = new Map<string, LiveNotification>()

// Drop our reference to a fired notification (and cancel its auto-dismiss timer).
// Guarded so a stale close (an old same-tag notification the OS retired when it
// was replaced) can't evict the newer notification now tracked under the tag.
function forgetNotification(tag: string, n: Notification): void {
  const entry = liveNotifications.get(tag)
  if (!entry || entry.n !== n) return
  if (entry.timer !== undefined) clearTimeout(entry.timer)
  liveNotifications.delete(tag)
}

// dismissNotification closes an OS notification we previously fired under `tag`,
// if it's still tracked (i.e. still on screen). A no-op when nothing was fired
// for the tag, when it was already dismissed/expired/clicked, or when the browser
// doesn't support the API. Callers use this when the condition that raised the
// notification clears, so a stale prompt doesn't linger after it's moot.
export function dismissNotification(tag: string): void {
  const entry = liveNotifications.get(tag)
  if (!entry) return
  if (entry.timer !== undefined) clearTimeout(entry.timer)
  liveNotifications.delete(tag)
  try {
    entry.n.close()
  } catch {
    // best-effort - close can throw in some embedded webviews.
  }
}

// fireNotification shows one OS notification, if the user has opted in and the
// browser has granted permission. Callers gate on visibility themselves (we only
// want these while the tab is NOT in front - a focused tab already gets the toast).
//
// `tag` coalesces: a second notification with the same tag replaces the first in
// the OS tray rather than stacking, so a re-fire for the same agent/approval
// doesn't pile up. `sticky` (requireInteraction) keeps blocking prompts on screen
// until dismissed; informational "finished" notes auto-expire.
//
// `autoDismissMs` (optional, > 0) closes the notification via a timer after that
// long. The Notification API has no built-in TTL, and a `sticky` notification
// stays up until the user acts, so this bounds one the user never gets to - it's
// closed instead of sitting in the tray forever. The fired notification is
// tracked by tag so dismissNotification can retract it early.
//
// `icon` is an image URL shown alongside the notification. Browsers otherwise
// pick their own mark (often the generic browser logo rather than our favicon),
// so callers pass the project's icon explicitly - it identifies *which* project
// woke you, which is the thing you can't tell from an out-of-tab alert. See
// lib/projectIconUrl for turning a project's icon into a URL.
export function fireNotification(opts: {
  title: string
  body: string
  tag: string
  sticky: boolean
  onClick: () => void
  autoDismissMs?: number
  icon?: string
}): void {
  const { enabled, permission } = useNotifyStore.getState()
  if (!enabled || permission !== 'granted' || !notificationsSupported()) return
  let n: Notification
  try {
    n = new Notification(opts.title, {
      body: opts.body,
      tag: opts.tag,
      requireInteraction: opts.sticky,
      icon: opts.icon ?? DEFAULT_ICON_URL,
    })
  } catch {
    // Some browsers only allow construction via a service worker; degrade silently.
    return
  }
  // Cancel any prior same-tag timer before it can close the fresh notification,
  // then track this one so it can be dismissed (early, by tag) or auto-dismissed.
  const prior = liveNotifications.get(opts.tag)
  if (prior?.timer !== undefined) clearTimeout(prior.timer)
  const entry: LiveNotification = { n }
  liveNotifications.set(opts.tag, entry)
  // Keep the registry in sync when the OS closes it (user swipe, expiry, replace).
  n.onclose = () => forgetNotification(opts.tag, n)
  if (opts.autoDismissMs !== undefined && opts.autoDismissMs > 0) {
    entry.timer = setTimeout(() => {
      try {
        n.close()
      } catch {
        // best-effort
      }
      forgetNotification(opts.tag, n)
    }, opts.autoDismissMs)
  }
  n.onclick = () => {
    try {
      window.focus()
    } catch {
      // ignore - focusing is best-effort
    }
    n.close()
    forgetNotification(opts.tag, n)
    opts.onClick()
  }
}
