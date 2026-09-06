import { Plus, Trash2 } from 'lucide-react'
import { DEFAULT_GENERATED_FILE_GLOBS, useGeneratedFileRulesStore } from '../../lib/generatedFile'
import { Tooltip } from '../Tooltip'
import { SettingSection } from './shared'

const inputClass =
  'min-w-0 flex-1 rounded-lg border border-gray-200 bg-white px-3 py-2 font-mono text-xs text-gray-800 shadow-inner ' +
  'focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100'

function scopeLabel(rule: string): string {
  if (!rule.trim()) return 'Empty rules match nothing.'
  return rule.includes('/')
    ? 'Matches the complete repository-relative path.'
    : 'Matches filenames in any directory.'
}

export function GeneratedFilesSection() {
  const rules = useGeneratedFileRulesStore((state) => state.rules)
  const setRules = useGeneratedFileRulesStore((state) => state.setRules)
  const update = (index: number, rule: string) => setRules(rules.map((value, i) => i === index ? rule : value))
  const remove = (index: number) => setRules(rules.filter((_, i) => i !== index))

  return (
    <SettingSection
      title="Auto-generated files"
      description="Files matching these case-insensitive globs start collapsed in diffs. Use * within one path segment, ** across directories, ? for one character, and {a,b} for alternatives. Changes save immediately in this browser."
    >
      <div className="max-h-80 space-y-2 overflow-y-auto rounded-xl border border-gray-200 bg-gray-50/60 p-2 dark:border-gray-700 dark:bg-gray-800/40">
        {rules.map((rule, index) => (
          <div key={index} className="rounded-lg bg-white p-2 shadow-sm dark:bg-gray-900">
            <div className="flex items-center gap-1.5">
              <input
                value={rule}
                onChange={(event) => update(index, event.target.value)}
                aria-label={`Auto-generated file glob ${index + 1}`}
                placeholder="docs/generated/**"
                className={inputClass}
              />
              <Tooltip content="Remove rule">
                <button
                  type="button"
                  aria-label={`Remove auto-generated file glob ${index + 1}`}
                  onClick={() => remove(index)}
                  className="shrink-0 rounded-md p-2 text-gray-400 transition-colors hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950/40 dark:hover:text-red-400 cursor-pointer"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </Tooltip>
            </div>
            <p className="mt-1 px-1 text-3xs text-gray-400 dark:text-gray-500">{scopeLabel(rule)}</p>
          </div>
        ))}
        {rules.length === 0 && (
          <p className="px-3 py-5 text-center text-xs text-gray-400 dark:text-gray-500">No path rules. Generated-file banners are still detected.</p>
        )}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setRules([...rules, ''])}
          disabled={rules.length >= 100}
          className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-xs font-medium text-gray-600 transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-gray-800 cursor-pointer"
        >
          <Plus className="h-3.5 w-3.5" />
          Add rule
        </button>
        <button
          type="button"
          onClick={() => setRules([...DEFAULT_GENERATED_FILE_GLOBS])}
          className="px-2 py-1.5 text-xs text-gray-500 transition-colors hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-200 cursor-pointer"
        >
          Restore built-in rules
        </button>
      </div>
      <p className="mt-2 text-3xs text-gray-400 dark:text-gray-500">
        A generated or do-not-edit marker in the first line also marks a file as auto-generated, independently of these path rules.
      </p>
    </SettingSection>
  )
}
