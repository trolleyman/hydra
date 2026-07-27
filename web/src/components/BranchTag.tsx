import { GitBranch } from 'lucide-react'
import { copyBranchName } from '../lib/branch'
import { Tooltip } from './Tooltip'
import { useCopyFlash } from '../lib/useCopyFlash'
import { CopyStateIcon } from './CopyStateIcon'

// BranchTag renders an agent's branch as a mono tag with a branch icon, plus a
// copy button just after the name (the "B" keyboard shortcut copies the same
// thing - see AgentDetail).
//
// The onCopy handler exists to strip the trailing newline that browsers append
// when a flex/block element is fully selected: triple-clicking the tag and
// hitting Ctrl+C would otherwise yield "hydra/foo\n". We re-serialise the live
// selection ourselves (trailing whitespace trimmed) so the clipboard carries
// just the branch name - while still honouring a partial selection.
export function BranchTag({ branch }: { branch: string }) {
  const { state, flash } = useCopyFlash(1200)
  return (
    <span
      className="text-xs font-mono text-gray-500 dark:text-gray-400 flex items-center gap-1.5"
      onCopy={(e) => {
        const selected = window.getSelection()?.toString() ?? ''
        const cleaned = selected.replace(/\s+$/, '')
        if (!cleaned) return
        e.preventDefault()
        e.clipboardData.setData('text/plain', cleaned)
      }}
    >
      <GitBranch className="w-3.5 h-3.5" />
      {branch}
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
          className="cursor-pointer text-gray-400 hover:text-gray-700 dark:text-gray-500 dark:hover:text-gray-200 transition-colors"
          onClick={() => { void copyBranchName(branch).then(flash) }}
        >
          <CopyStateIcon state={state} />
        </button>
      </Tooltip>
    </span>
  )
}
