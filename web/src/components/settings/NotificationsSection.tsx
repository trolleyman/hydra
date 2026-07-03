import { useEffect } from 'react'
import { useNotifyStore, notificationsSupported } from '../../lib/notifyPrefs'
import { SettingSection, EnabledToggle } from './shared'

// Desktop notifications - a client-only, global user preference (localStorage,
// like Theme / Terminal). When on, Hydra fires an OS notification for an agent
// transition (needs input / approval / finished) that happens while this tab is
// backgrounded or unfocused. The toggle doubles as the required user gesture for
// the browser's permission prompt (see lib/notifyPrefs).
export function NotificationsSection() {
  const enabled = useNotifyStore((s) => s.enabled)
  const permission = useNotifyStore((s) => s.permission)
  const setEnabled = useNotifyStore((s) => s.setEnabled)
  const refreshPermission = useNotifyStore((s) => s.refreshPermission)

  // The OS permission can change outside the app (browser site settings); re-sync
  // it when the settings page opens so the toggle isn't stale.
  useEffect(() => refreshPermission(), [refreshPermission])

  const supported = notificationsSupported()
  const blocked = permission === 'denied'
  // "On" only when both the preference and the OS permission agree.
  const on = enabled && permission === 'granted'
  // Blocked/unsupported can't be toggled on - dim the switch and let the hint
  // explain why, rather than showing a control that does nothing when clicked.
  const disabled = !supported || blocked

  let hint: string
  if (!supported) {
    hint = 'This browser does not support desktop notifications.'
  } else if (blocked) {
    hint =
      'Notifications are blocked for this site in your browser settings. Re-allow them there to turn this on.'
  } else if (on) {
    hint =
      'You will get a desktop notification when an agent needs input, is waiting on an approval, or finishes while this tab is in the background or unfocused.'
  } else {
    hint =
      'Get a desktop notification when an agent needs input, is waiting on an approval, or finishes while this Hydra tab is in the background or unfocused.'
  }

  return (
    <SettingSection title="Desktop notifications" description={hint}>
      <div className={disabled ? 'opacity-50 pointer-events-none' : undefined}>
        <EnabledToggle enabled={on} onChange={(v) => void setEnabled(v)} />
      </div>
    </SettingSection>
  )
}
