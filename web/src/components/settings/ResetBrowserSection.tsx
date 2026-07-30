import { SettingSection } from './shared'
import { ResetPrefsButton } from './ResetPrefsButton'
import { useChangedBrowserPrefCount } from '../../lib/browserPrefs'

// Puts every preference on this tab - and only this tab - back to its default.
// It sits at the bottom because it is the thing you want AFTER trying the ones
// above, and because a reset button at the top of a settings page is a thing to
// mis-click. The Fonts section has its own narrower one in its header.
//
// Deliberately scoped to the Browser tab's own prefs. It does NOT touch the
// project/local/user config files (those have a Save button and live on disk),
// nor the incidental client state that is not a preference at all - sidebar
// width, per-agent view state, diff toggles, draft comments. Those are things
// you set by using the app rather than by choosing them here, and sweeping them
// up in "reset to defaults" would be a surprise.
export function ResetBrowserSection() {
  const changed = useChangedBrowserPrefCount()
  return (
    <SettingSection
      title="Reset"
      description="Every setting on this tab, back to how it shipped. Saved per browser, so it changes nothing on disk and nothing on your other devices."
    >
      <div className="flex items-center gap-3">
        <ResetPrefsButton what="browser settings" />
        {changed > 0 && (
          <span className="text-xs text-gray-500 dark:text-gray-400">
            {changed} {changed === 1 ? 'setting differs' : 'settings differ'} from the default
          </span>
        )}
      </div>
    </SettingSection>
  )
}
