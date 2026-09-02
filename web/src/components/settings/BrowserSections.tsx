import { ThemeSection } from './ThemeSection'
import { ComposerSection } from './ComposerSection'
import { EnterSendsSection } from './EnterSendsSection'
import { AutoPairSection } from './AutoPairSection'
import { SpellcheckSection } from './SpellcheckSection'
import { FontSection } from './FontSection'
import { StreamingSection } from './StreamingSection'
import { StepGroupsSection } from './StepGroupsSection'
import { CodeLineNumbersSection } from './CodeLineNumbersSection'
import { WhitespaceSection } from './WhitespaceSection'
import { BashIndentSection } from './BashIndentSection'
import { ChatHeightSection } from './ChatHeightSection'
import { TerminalSection } from './TerminalSection'
import { NotificationsSection } from './NotificationsSection'
import { ResetBrowserSection } from './ResetBrowserSection'
import { DesktopLifetimeSection } from './DesktopLifetimeSection'

// The Browser tab of the settings pages: the client-only preferences (theme /
// paste markers / auto-close pairs / spellcheck / fonts / step folding / smooth
// streaming / code line numbers / whitespace marks / shell command indent / chat
// height / terminal / desktop notifications) in this browser's localStorage.
// They save instantly on change - no config file, no Save button - which is why
// the tab ends with a reset: there is no Cancel to fall back on.
export function BrowserSections() {
  return (
    <>
      <ThemeSection />
      <ComposerSection />
      <EnterSendsSection />
      <AutoPairSection />
      <SpellcheckSection />
      <FontSection />
      <StepGroupsSection />
      <StreamingSection />
      <CodeLineNumbersSection />
      <WhitespaceSection />
      <BashIndentSection />
      <ChatHeightSection />
      <TerminalSection />
      <NotificationsSection />
      <DesktopLifetimeSection />
      <ResetBrowserSection />
    </>
  )
}
