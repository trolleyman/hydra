import { useChatFontStore } from '../../lib/chatPrefs'
import { SettingSection } from './shared'

// Chat font - a client-only, global preference (localStorage, like Theme) for
// the typeface of chat-mode agent messages: serif (the default, Claude-app
// look) or sans. The user's own messages and all code stay sans/mono either way.
const OPTIONS: { id: 'serif' | 'sans'; label: string; font: string }[] = [
  { id: 'serif', label: 'Serif', font: 'font-serif' },
  { id: 'sans', label: 'Sans', font: 'font-sans' },
]

export function ChatSection() {
  const serif = useChatFontStore((s) => s.serif)
  const setSerif = useChatFontStore((s) => s.setSerif)
  const active = serif ? 'serif' : 'sans'
  return (
    <SettingSection
      title="Chat font"
      description="Typeface for chat-mode agent messages. Your own messages and code always stay sans-serif."
    >
      <div className="inline-flex rounded-lg border border-gray-200 dark:border-gray-700 p-1 bg-gray-50 dark:bg-gray-900/40">
        {OPTIONS.map((o) => {
          const isActive = active === o.id
          return (
            <button
              key={o.id}
              type="button"
              onClick={() => setSerif(o.id === 'serif')}
              aria-pressed={isActive}
              className={`${o.font} px-3 py-1.5 rounded-md text-sm font-medium transition-colors cursor-pointer ${
                isActive
                  ? 'bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 shadow-sm'
                  : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'
              }`}
            >
              {o.label}
            </button>
          )
        })}
      </div>
    </SettingSection>
  )
}
