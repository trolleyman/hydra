import { useChatStreamStore } from '../../lib/chatPrefs'
import { SettingSection, EnabledToggle } from './shared'

// Smooth streaming - a client-only, global preference (localStorage, like Theme).
// On (the default): incoming token bursts are revealed at a steady per-frame rate
// so chat-mode agent text reads as continuous typing. Off: text lands the instant
// each delta arrives (the claude CLI flushes ~5x/sec, so it appears in chunks).
export function StreamingSection() {
  const smooth = useChatStreamStore((s) => s.smooth)
  const setSmooth = useChatStreamStore((s) => s.setSmooth)
  return (
    <SettingSection
      title="Smooth streaming"
      description="Reveal chat-mode agent text as steady, continuous typing. Off shows each token burst the instant it arrives (faster, but choppier)."
    >
      <EnabledToggle enabled={smooth} onChange={setSmooth} />
    </SettingSection>
  )
}
