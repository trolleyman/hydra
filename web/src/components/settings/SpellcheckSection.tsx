import { useSpellcheckStore } from '../../lib/composerPrefs'
import { SettingSection, EnabledToggle } from './shared'

// The browser's own spellchecker in Hydra's text boxes - a client-only, global
// preference (localStorage, like Theme). Off by default: a prompt is mostly
// filenames, branch names and pasted code, so most of what the browser marks is
// not a typo. See lib/composerPrefs for why it can only be all-or-nothing.
export function SpellcheckSection() {
  const enabled = useSpellcheckStore((s) => s.enabled)
  const setEnabled = useSpellcheckStore((s) => s.setEnabled)
  return (
    <SettingSection
      title="Spellcheck"
      description="Let the browser underline misspelled words as you type in a composer, a review comment or a commit message. Off by default - a prompt is full of filenames, branch names and code, and the browser marks those as typos. Which words it marks, and when, is up to the browser: it cannot be told to skip [image1.png]."
    >
      <EnabledToggle enabled={enabled} onChange={setEnabled} />
    </SettingSection>
  )
}
