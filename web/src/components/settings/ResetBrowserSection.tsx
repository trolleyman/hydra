import { RotateCcw } from 'lucide-react'
import { SettingSection } from './shared'
import { Tooltip } from '../Tooltip'
import { useDialogStore } from '../../stores/dialogStore'
import { useToastStore } from '../../stores/toastStore'
import {
  changedBrowserPrefs,
  describeChanged,
  resetBrowserPrefs,
  useChangedBrowserPrefCount,
} from '../../lib/browserPrefs'

// Puts every preference on this tab - and only this tab - back to its default.
// It sits at the bottom because it is the thing you want AFTER trying the ones
// above, and because a reset button at the top of a settings page is a thing to
// mis-click.
//
// Deliberately scoped to the Browser tab's own prefs. It does NOT touch the
// project/local/user config files (those have a Save button and live on disk),
// nor the incidental client state that is not a preference at all - sidebar
// width, per-agent view state, diff toggles, draft comments. Those are things
// you set by using the app rather than by choosing them here, and sweeping them
// up in "reset to defaults" would be a surprise.
export function ResetBrowserSection() {
  const changed = useChangedBrowserPrefCount()
  const none = changed === 0

  const confirm = () => {
    const prefs = changedBrowserPrefs()
    if (prefs.length === 0) return
    useDialogStore.getState().show({
      title: 'Reset browser settings',
      // Name what actually moves. "Reset all settings to their defaults?" makes
      // you guess how much "all" is, and this tab holds two dozen knobs.
      message: `Put ${describeChanged(prefs)} back to ${prefs.length === 1 ? 'its default' : 'their defaults'}? This only affects this browser - nothing on disk, and no other device.`,
      type: 'warning',
      confirmLabel: prefs.length === 1 ? 'Reset it' : `Reset ${prefs.length}`,
      showCancel: true,
      onConfirm: () => {
        resetBrowserPrefs()
        useToastStore.getState().show({
          message: `Reset ${prefs.length} ${prefs.length === 1 ? 'setting' : 'settings'} to ${prefs.length === 1 ? 'its default' : 'their defaults'}.`,
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
      className={
        'flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-xs font-medium transition-colors ' +
        (none
          ? 'border-gray-200 dark:border-gray-700 text-gray-400 dark:text-gray-600 cursor-default'
          : 'border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 cursor-pointer')
      }
    >
      <RotateCcw className="w-3.5 h-3.5 shrink-0" />
      <span className="optical-center">Reset to defaults</span>
    </button>
  )

  return (
    <SettingSection
      title="Reset"
      description="Every setting on this tab, back to how it shipped. Saved per browser, so it changes nothing on disk and nothing on your other devices."
    >
      <div className="flex items-center gap-3">
        {/* A disabled button explains itself rather than just sitting dead - the
            tooltip is the only way to tell "nothing to do" from "broken". A
            disabled control swallows pointer events, so the tooltip goes on a
            wrapper rather than on the button. */}
        {none ? <Tooltip content="Everything on this tab is already at its default">{button}</Tooltip> : button}
        {!none && (
          <span className="text-xs text-gray-500 dark:text-gray-400">
            {changed} {changed === 1 ? 'setting differs' : 'settings differ'} from the default
          </span>
        )}
      </div>
    </SettingSection>
  )
}
