import { ThemeSection } from './ThemeSection'
import { ComposerSection } from './ComposerSection'
import { AutoPairSection } from './AutoPairSection'
import { FontSection } from './FontSection'
import { StreamingSection } from './StreamingSection'
import { CodeLineNumbersSection } from './CodeLineNumbersSection'
import { BashIndentSection } from './BashIndentSection'
import { ChatHeightSection } from './ChatHeightSection'
import { TerminalSection } from './TerminalSection'
import { NotificationsSection } from './NotificationsSection'

// The Browser tab of the settings pages: the client-only preferences (theme /
// paste markers / auto-close pairs / fonts / smooth streaming / code line
// numbers / shell command indent / chat height / terminal / desktop
// notifications) that live in this browser's localStorage. They save instantly
// on change - no config file, no Save button.
export function BrowserSections() {
  return (
    <>
      <ThemeSection />
      <ComposerSection />
      <AutoPairSection />
      <FontSection />
      <StreamingSection />
      <CodeLineNumbersSection />
      <BashIndentSection />
      <ChatHeightSection />
      <TerminalSection />
      <NotificationsSection />
    </>
  )
}
