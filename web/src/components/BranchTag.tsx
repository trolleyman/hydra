import { Tag } from 'lucide-react'

// BranchTag renders an agent's branch as a mono tag with a tag icon.
//
// The onCopy handler exists to strip the trailing newline that browsers append
// when a flex/block element is fully selected: triple-clicking the tag and
// hitting Ctrl+C would otherwise yield "hydra/foo\n". We re-serialise the live
// selection ourselves (trailing whitespace trimmed) so the clipboard carries
// just the branch name - while still honouring a partial selection.
export function BranchTag({ branch }: { branch: string }) {
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
      <Tag className="w-3.5 h-3.5" />
      {branch}
    </span>
  )
}
