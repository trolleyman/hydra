import { formatBashForDisplay, MAX_BASH_INDENT } from '../../lib/bashFormat'
import { useChatBashIndentStore } from '../../lib/chatPrefs'
import { SettingSection } from './shared'

// The widths offered. Anything in 0..MAX_BASH_INDENT is honoured if it somehow
// lands in localStorage; these are just the ones worth a button.
const WIDTHS = [0, 2, 4, 8]

// The sample the preview is rendered from - one chained command with a loop and
// a case, so every level the formatter produces is visible.
const SAMPLE = 'cd /path && for f in *.log; do case $f in *.gz) gunzip $f ;; *) wc -l $f ;; esac; done'

// Shell command indent - a client-only, global preference (localStorage, like
// Theme). A one-line Bash command in the chat transcript (and on the security
// approval card) is laid out over several lines, with the body of a for/while/
// if/case block indented; this is how far. 0 leaves bodies flush left, which
// keeps a deeply nested command narrow when the chat pane is.
export function BashIndentSection() {
  const indent = useChatBashIndentStore((s) => s.indent)
  const setIndent = useChatBashIndentStore((s) => s.setIndent)
  const active = Math.min(MAX_BASH_INDENT, Math.max(0, indent))
  return (
    <SettingSection
      title="Shell command indent"
      description="Spaces the chat transcript and approval cards indent the body of a for/while/if/case block by when they lay a one-line shell command out over several lines."
    >
      <div className="flex flex-wrap items-start gap-3">
        <div className="inline-flex rounded-lg border border-gray-200 dark:border-gray-700 p-1 bg-gray-50 dark:bg-gray-900/40">
          {WIDTHS.map((w) => (
            <button
              key={w}
              type="button"
              onClick={() => setIndent(w)}
              aria-pressed={active === w}
              aria-label={w === 0 ? 'No indent' : `${w} spaces`}
              className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors cursor-pointer ${
                active === w
                  ? 'bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 shadow-sm'
                  : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'
              }`}
            >
              {w === 0 ? 'None' : w}
            </button>
          ))}
        </div>
        <pre className="flex-1 min-w-[16rem] overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 font-mono text-2xs leading-[1.5] text-gray-600 dark:text-gray-300">
          {formatBashForDisplay(SAMPLE, '', active)}
        </pre>
      </div>
    </SettingSection>
  )
}
