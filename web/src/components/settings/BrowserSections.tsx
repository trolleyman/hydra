import { ThemeSection } from './ThemeSection'
import { ComposerSection } from './ComposerSection'
import { AutoPairSection } from './AutoPairSection'
import { FontSection } from './FontSection'
import { StreamingSection } from './StreamingSection'
import { StepGroupsSection } from './StepGroupsSection'
import { CodeLineNumbersSection } from './CodeLineNumbersSection'
import { WhitespaceSection } from './WhitespaceSection'
import { BashIndentSection } from './BashIndentSection'
import { ChatHeightSection } from './ChatHeightSection'
import { TerminalSection } from './TerminalSection'
import { NotificationsSection } from './NotificationsSection'

// The Browser tab of the settings pages: the client-only preferences (theme /
// paste markers / auto-close pairs / fonts / step folding / smooth streaming /
// code line numbers / whitespace marks / shell command indent / chat height /
// terminal / desktop notifications) that live in this browser's localStorage.
// They save instantly on change - no config file, no Save button.
export function BrowserSections() {
  return (
    <>
      <ThemeSection />
      <ComposerSection />
      <AutoPairSection />
      <FontSection />
      <StepGroupsSection />
      <StreamingSection />
      <CodeLineNumbersSection />
      <WhitespaceSection />
      <BashIndentSection />
      <ChatHeightSection />
      <TerminalSection />
      <NotificationsSection />
    </>
  )
}
