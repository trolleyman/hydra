import { ThemeSection } from './ThemeSection'
import { TerminalSection } from './TerminalSection'
import { NotificationsSection } from './NotificationsSection'
import { DefaultActionSection } from './DefaultActionSection'

// The Browser tab of the settings pages: the client-only preferences (theme /
// terminal / desktop notifications / primary head action) that live in this
// browser's localStorage. They save instantly on change - no config file, no
// Save button involved.
export function BrowserSections() {
  return (
    <>
      <ThemeSection />
      <TerminalSection />
      <DefaultActionSection />
      <NotificationsSection />
    </>
  )
}
