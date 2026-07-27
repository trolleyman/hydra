import { useChatCodeLinesStore } from '../../lib/chatPrefs'
import { SettingSection, EnabledToggle } from './shared'

// Code line numbers - a client-only, global preference (localStorage, like
// Theme). On (the default): multi-line code blocks in the chat transcript (a
// Bash command, a tool's JSON input) get a 1..N gutter, so a long line that
// wraps is not mistaken for a second command. Off: plain code, no gutter.
export function CodeLineNumbersSection() {
  const lineNumbers = useChatCodeLinesStore((s) => s.lineNumbers)
  const setLineNumbers = useChatCodeLinesStore((s) => s.setLineNumbers)
  return (
    <SettingSection
      title="Code line numbers"
      description="Number the lines of multi-line code blocks in the chat transcript, so a wrapped long line reads as one line rather than two."
    >
      <EnabledToggle enabled={lineNumbers} onChange={setLineNumbers} />
    </SettingSection>
  )
}
