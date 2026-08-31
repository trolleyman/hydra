import { useFeatureFlagsStore } from '../../lib/featureFlags'
import { EnabledToggle, SettingSection } from './shared'

// Experimental client-only switches live apart from the ordinary Browser tab:
// both are default-off diagnostics for scroll behavior and can change or be
// removed once the underlying platform interactions are understood.
export function FeatureFlagsSections() {
  const smoothChatWheel = useFeatureFlagsStore((s) => s.smoothChatWheel)
  const customScrollbars = useFeatureFlagsStore((s) => s.customScrollbars)
  const setSmoothChatWheel = useFeatureFlagsStore((s) => s.setSmoothChatWheel)
  const setCustomScrollbars = useFeatureFlagsStore((s) => s.setCustomScrollbars)

  return (
    <>
      <SettingSection
        title="Smooth chat wheel scrolling"
        description="Ease coarse mouse-wheel notches in the chat transcript on desktop. Off leaves wheel and touchpad input entirely to the browser."
      >
        <EnabledToggle enabled={smoothChatWheel} onChange={setSmoothChatWheel} />
      </SettingSection>
      <SettingSection
        title="Custom scrollbars"
        description="Use Hydra's thin, button-less scrollbar styling throughout the app. Off uses the browser and operating system scrollbar chrome."
      >
        <EnabledToggle enabled={customScrollbars} onChange={setCustomScrollbars} />
      </SettingSection>
    </>
  )
}
