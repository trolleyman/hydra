import { GitMerge, GitPullRequestCreate } from 'lucide-react'
import { useDefaultAction, type PrimaryAction } from '../../lib/uiPrefs'
import { SettingSection } from './shared'

const OPTIONS: { value: PrimaryAction; label: string; icon: typeof GitMerge }[] = [
  { value: 'merge', label: 'Merge (local)', icon: GitMerge },
  { value: 'create_mr', label: 'Create MR', icon: GitPullRequestCreate },
]

// Primary action - which of the two head-header buttons (Merge / Create MR) is
// primary. A client-only preference (localStorage), because it only orders the
// buttons; it is deliberately NOT a project/review setting. Unset defaults to
// Merge (or the project's [review] default_action, applied in the agent header).
export function DefaultActionSection() {
  const action = useDefaultAction((s) => s.action)
  const setAction = useDefaultAction((s) => s.setAction)
  const effective = action ?? 'merge'
  return (
    <SettingSection
      title="Primary action"
      description="Which button leads in the agent header. Merge merges locally; Create MR opens a forge merge request. The other stays one click away. Stored by this browser."
    >
      <div className="inline-flex rounded-lg border border-gray-200 dark:border-gray-700 p-1 bg-gray-50 dark:bg-gray-900/40">
        {OPTIONS.map(({ value, label, icon: Icon }) => {
          const active = effective === value
          return (
            <button
              key={value}
              type="button"
              onClick={() => setAction(value)}
              aria-pressed={active}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-colors cursor-pointer ${
                active
                  ? 'bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 shadow-sm'
                  : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'
              }`}
            >
              <Icon className="w-4 h-4" />
              {label}
            </button>
          )
        })}
      </div>
    </SettingSection>
  )
}
