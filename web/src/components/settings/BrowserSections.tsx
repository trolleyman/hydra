import { ThemeSection } from './ThemeSection'
import { ComposerSection } from './ComposerSection'
import { ChatSection } from './ChatSection'
import { StreamingSection } from './StreamingSection'
import { CodeLineNumbersSection } from './CodeLineNumbersSection'
import { ChatHeightSection } from './ChatHeightSection'
import { TerminalSection } from './TerminalSection'
import { NotificationsSection } from './NotificationsSection'

// The Browser tab of the settings pages: the client-only preferences (theme /
// chat font / smooth streaming / code line numbers / chat height / terminal /
// desktop notifications) that live in this browser's localStorage. They save instantly on change - no
// config file, no Save button.
export function BrowserSections() {
  return (
    <>
      <ThemeSection />
      <ComposerSection />
      <ChatSection />
      <StreamingSection />
      <CodeLineNumbersSection />
      <ChatHeightSection />
      <TerminalSection />
      <NotificationsSection />
    </>
  )
}
