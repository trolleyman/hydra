import { useEnterSendsStore } from '../../lib/composerPrefs'
import { SettingSection, EnabledToggle } from './shared'

// Chat-composer Enter behaviour - a client-only, global preference
// (localStorage, like Theme). Enter sends by default. Off gives Enter back to
// multiline editing and makes Cmd/Ctrl+Enter the send shortcut instead.
export function EnterSendsSection() {
  const enabled = useEnterSendsStore((s) => s.enabled)
  const setEnabled = useEnterSendsStore((s) => s.setEnabled)
  return (
    <SettingSection
      title="Enter sends"
      description="Send a chat message with Enter. Turn this off to add a newline with Enter and send with Cmd/Ctrl+Enter instead. Shift+Enter always adds a newline."
    >
      <EnabledToggle enabled={enabled} onChange={setEnabled} />
    </SettingSection>
  )
}
