import { RotateCcw } from 'lucide-react'
import { Tooltip } from '../Tooltip'
import { useDialogStore } from '../../stores/dialogStore'
import { useToastStore } from '../../stores/toastStore'
import {
  changedBrowserPrefs,
  describeChanged,
  resetBrowserPrefs,
  useChangedBrowserPrefCount,
  type PrefGroup,
} from '../../lib/browserPrefs'

// The reset control, used at two scopes: the Fonts section header (`group`
// set) and the bottom of the Browser tab (no group, meaning everything). One
// component so the two cannot behave differently - same confirm, same wording,
// same disabled state, same toast.
export function ResetPrefsButton({
  group,
  what,
  size = 'md',
}: {
  /** Which prefs to reset. Omit for every pref on the Browser tab. */
  group?: PrefGroup
  /** What the dialog calls them ("browser settings", "fonts"). */
  what: string
  /** 'sm' for a section header's action slot, 'md' for a section body. */
  size?: 'sm' | 'md'
}) {
  const changed = useChangedBrowserPrefCount(group)
  const none = changed === 0

  const confirm = () => {
    const prefs = changedBrowserPrefs(group)
    if (prefs.length === 0) return
    const one = prefs.length === 1
    useDialogStore.getState().show({
      title: `Reset ${what}`,
      // Name what actually moves. "Reset all settings to their defaults?" makes
      // you guess how much "all" is.
      message: `Put ${describeChanged(prefs)} back to ${one ? 'its default' : 'their defaults'}? This only affects this browser - nothing on disk, and no other device.`,
      type: 'warning',
      confirmLabel: one ? 'Reset it' : `Reset ${prefs.length}`,
      showCancel: true,
      onConfirm: () => {
        resetBrowserPrefs(group)
        useToastStore.getState().show({
          message: `Reset ${prefs.length} ${one ? 'setting' : 'settings'} to ${one ? 'its default' : 'their defaults'}.`,
          type: 'success',
        })
      },
    })
  }

  const button = (
    <button
      type="button"
      onClick={confirm}
      disabled={none}
      aria-label={`Reset ${what} to defaults`}
      className={
        'flex items-center gap-1.5 rounded-lg border font-medium transition-colors ' +
        (size === 'sm' ? 'px-2 py-1 text-2xs ' : 'px-2.5 py-1.5 text-xs ') +
        (none
          ? 'border-gray-200 dark:border-gray-700 text-gray-400 dark:text-gray-600 cursor-default'
          : 'border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 cursor-pointer')
      }
    >
      <RotateCcw className={size === 'sm' ? 'w-3 h-3 shrink-0' : 'w-3.5 h-3.5 shrink-0'} />
      <span className="optical-center">Reset{size === 'sm' ? '' : ' to defaults'}</span>
    </button>
  )

  // A disabled button explains itself rather than sitting dead - the tooltip is
  // the only way to tell "nothing to do" from "broken". A disabled control
  // swallows pointer events, so the tooltip goes on a wrapper, not the button.
  const tip = none
    ? `${what[0].toUpperCase()}${what.slice(1)} are already at their defaults`
    : `${changed} ${changed === 1 ? 'setting differs' : 'settings differ'} from the default`
  return <Tooltip content={tip}>{button}</Tooltip>
}
