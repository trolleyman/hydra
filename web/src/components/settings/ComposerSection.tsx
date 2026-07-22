import { usePasteMarkersStore } from '../../lib/composerPrefs'
import { SettingSection, EnabledToggle } from './shared'

// Paste markers - a client-only, global preference (localStorage, like Theme).
// On (the default): pasting an attachment (a screenshot, or a large text block
// that gets attached) into the spawn form or the chat composer also inserts its
// "[filename]" at the caret, so the prompt references the attachment
// explicitly. Off: only the chip is added.
export function ComposerSection() {
  const enabled = usePasteMarkersStore((s) => s.enabled)
  const setEnabled = usePasteMarkersStore((s) => s.setEnabled)
  return (
    <SettingSection
      title="Paste markers"
      description="Pasting an image or a large text block into a composer also inserts its [filename] into the text, so the prompt references the attachment explicitly."
    >
      <EnabledToggle enabled={enabled} onChange={setEnabled} />
    </SettingSection>
  )
}
