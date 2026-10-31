import { useRichTextEditorStore } from '../../lib/composerPrefs'
import { SettingSection, EnabledToggle } from './shared'

export function RichTextEditorSection() {
  const enabled = useRichTextEditorStore((state) => state.enabled)
  const setEnabled = useRichTextEditorStore((state) => state.setEnabled)
  return (
    <SettingSection
      title="Rich text editor"
      description="Format Markdown while typing in chat, task prompts, reviews and notes. Turn off to edit Markdown source. Reload the page after changing this setting; saved drafts and uploaded attachments are kept."
    >
      <EnabledToggle enabled={enabled} onChange={setEnabled} />
    </SettingSection>
  )
}
