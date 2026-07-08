import { ThemeSection } from './ThemeSection'
import { ChatSection } from './ChatSection'
import { ChatHeightSection } from './ChatHeightSection'
import { TerminalSection } from './TerminalSection'
import { NotificationsSection } from './NotificationsSection'

// The Browser tab of the settings pages: the client-only preferences (theme /
// chat font / chat height / terminal / desktop notifications) that live in this browser's
// localStorage. They save instantly on change - no config file, no Save button.
export function BrowserSections() {
  return (
    <>
      <ThemeSection />
      <ChatSection />
      <ChatHeightSection />
      <TerminalSection />
      <NotificationsSection />
    </>
  )
}
