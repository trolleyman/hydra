import { Check, Copy, Tag } from 'lucide-react'
import { useRef, useState } from 'react'
import { copyBranchName } from '../lib/branch'

// BranchTag renders an agent's branch as a mono tag with a tag icon, plus a
// copy button just after the name (the "B" keyboard shortcut copies the same
// thing - see AgentDetail).
//
// The onCopy handler exists to strip the trailing newline that browsers append
// when a flex/block element is fully selected: triple-clicking the tag and
// hitting Ctrl+C would otherwise yield "hydra/foo\n". We re-serialise the live
// selection ourselves (trailing whitespace trimmed) so the clipboard carries
// just the branch name - while still honouring a partial selection.
export function BranchTag({ branch }: { branch: string }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
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
      <button
        type="button"
        title="Copy branch name"
        aria-label="Copy branch name"
        className="text-gray-400 hover:text-gray-700 dark:text-gray-500 dark:hover:text-gray-200 transition-colors"
        onClick={() => {
          copyBranchName(branch)
          setCopied(true)
          clearTimeout(timer.current)
          timer.current = setTimeout(() => setCopied(false), 1200)
        }}
      >
        {copied ? <Check className="w-3.5 h-3.5 text-green-500" /> : <Copy className="w-3.5 h-3.5" />}
      </button>
    </span>
  )
}
