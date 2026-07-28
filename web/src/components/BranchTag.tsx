import { GitBranch } from 'lucide-react'
import { copyBranchName } from '../lib/branch'
import { Tooltip } from './Tooltip'
import { useCopyFlash } from '../lib/useCopyFlash'
import { CopyStateIcon } from './CopyStateIcon'

// BranchTag renders an agent's branch as a mono tag with a branch icon, plus a
// copy button just after the name (the "B" keyboard shortcut copies the same
// thing - see AgentDetail).
//
// `label` overrides the displayed text without changing what is copied or
// selected - the agent header shows the bare head id (the branch minus its
// `hydra/` prefix) while still putting the real branch name on the clipboard.
// `icon={false}` drops the branch glyph for callers whose row already reads as
// a branch without it.
//
// The onCopy handler exists to strip the trailing newline that browsers append
// when a flex/block element is fully selected: triple-clicking the tag and
// hitting Ctrl+C would otherwise yield "hydra/foo\n". We re-serialise the live
// selection ourselves (trailing whitespace trimmed) so the clipboard carries
// just the branch name - while still honouring a partial selection.
export function BranchTag({
  branch,
  label,
  icon = true,
  className = 'text-xs font-mono text-gray-500 dark:text-gray-400',
}: {
  branch: string
  label?: string
  icon?: boolean
  className?: string
}) {
  const { state, flash } = useCopyFlash(1200)
  return (
    <span
      className={`${className} flex items-center gap-1.5 min-w-0`}
      onCopy={(e) => {
        const selected = window.getSelection()?.toString() ?? ''
        const cleaned = selected.replace(/\s+$/, '')
        if (!cleaned) return
        e.preventDefault()
        e.clipboardData.setData('text/plain', cleaned)
      }}
    >
      {icon && <GitBranch className="w-3.5 h-3.5 shrink-0" />}
      {/* No native title on the name. It only ever fired for a `label` caller (the
          agent header's bare head id), where it repeated the full branch name that
          the copy button's tooltip - right next to it - already shows, in OS
          chrome with its own delay. One tooltip on this row is enough. */}
      <span className="truncate">{label ?? branch}</span>
      <Tooltip
        content={
          <>
            <div>Copy branch name</div>
            <div className="text-gray-500 dark:text-gray-400">{branch}</div>
          </>
        }
      >
        <button
          type="button"
          aria-label="Copy branch name"
          className="cursor-pointer shrink-0 text-gray-400 hover:text-gray-700 dark:text-gray-500 dark:hover:text-gray-200 transition-colors"
          onClick={() => { void copyBranchName(branch).then(flash) }}
        >
          <CopyStateIcon state={state} />
        </button>
      </Tooltip>
    </span>
  )
}
