import { useSplitLayoutStore } from '../../lib/layout'
import { SettingSection, EnabledToggle } from './shared'

// Agent-page layout - a client-only, global preference (localStorage, like Theme
// / Terminal). When on (the default) the agent page uses the two-pane split: the
// terminal/chat on the left, an inspector pane (diff / tests / previews) on the
// right. Turning it off falls back to the classic single-column stacked layout.
// Only takes effect at lg+ viewports; narrow screens always use the stacked
// layout.
export function LayoutSection() {
  const enabled = useSplitLayoutStore((s) => s.enabled)
  const setEnabled = useSplitLayoutStore((s) => s.setEnabled)
  return (
    <SettingSection
      title="Two-pane agent layout"
      description="Show the diff, tests and previews in a resizable inspector pane beside the terminal/chat, instead of stacked in one scrolling column. Applies on wide screens; narrow screens always use the stacked layout."
    >
      <EnabledToggle enabled={enabled} onChange={setEnabled} />
    </SettingSection>
  )
}
