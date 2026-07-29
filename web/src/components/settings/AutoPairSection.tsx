import { useAutoPairStore } from '../../lib/composerPrefs'
import { SettingSection, EnabledToggle } from './shared'

// Auto-pairing in the composers - a client-only, global preference
// (localStorage, like Theme). On (the default): typing an opener inserts its
// closer, typing the closer steps back over it, Enter on a "```" line opens a
// fenced block, Backspace between an empty pair clears both, and a mark typed
// with text selected wraps the selection. Off: every key types exactly one
// character. The rules themselves are in lib/autoPair.ts.
export function AutoPairSection() {
  const enabled = useAutoPairStore((s) => s.enabled)
  const setEnabled = useAutoPairStore((s) => s.setEnabled)
  return (
    <SettingSection
      title="Auto-close pairs"
      description={
        'Typing ` ( [ { " or \' in a composer adds the closing character, and pressing Enter on a line that is just ``` ' +
        'opens a code block around the caret. Typing the closer steps over it, Backspace between an empty pair removes ' +
        'both, and typing ` * _ ~ ( [ { " \' with text selected wraps the selection instead.'
      }
    >
      <EnabledToggle enabled={enabled} onChange={setEnabled} />
    </SettingSection>
  )
}
