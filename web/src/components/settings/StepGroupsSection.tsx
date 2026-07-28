import { useChatStepsStore } from '../../lib/chatPrefs'
import { SettingSection, EnabledToggle } from './shared'

// Fold steps - a client-only, global preference (localStorage, like Theme). On
// (the default): a run of settled thoughts and finished tool calls in the chat
// transcript collapses into one "N steps" line you can click to expand. Off
// renders every card in full, as before. Anything still running or waiting on
// you never folds either way.
export function StepGroupsSection() {
  const grouped = useChatStepsStore((s) => s.grouped)
  const setGrouped = useChatStepsStore((s) => s.setGrouped)
  return (
    <SettingSection
      title="Fold steps"
      description="Collapse a run of finished thoughts and tool calls in chat into one expandable line, so the agent's replies stand out. Running steps and ones awaiting approval always stay visible."
    >
      <EnabledToggle enabled={grouped} onChange={setGrouped} />
    </SettingSection>
  )
}
