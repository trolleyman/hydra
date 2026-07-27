import { useState } from 'react'
import { GitBranch, Check, Copy } from 'lucide-react'
import { SettingsPopover, SettingsGroupLabel } from './SettingsPopover'
import { api } from '../stores/apiClient'

// TrackBranchButton is the small icon+chevron button in the agent header that
// opens a popover explaining how to check out and follow this head's branch from
// the user's own repo. On open it ensures the project's `hydra-agents` remote
// exists (a daemon action), so the shown command is just a `git checkout -t` -
// no long remote-setup incantation. The chevron marks it as a menu, not an action.
export function TrackBranchButton({ projectId, agentId }: { projectId: string; agentId: string }) {
  const [remote, setRemote] = useState('hydra-agents')
  const [copied, setCopied] = useState(false)
  const cmd = `git checkout -t ${remote}/${agentId}`

  // Set up the remote lazily when the popover opens. If it fails, the default
  // name still makes a valid command once the remote is configured by hand.
  async function ensure() {
    try {
      const res = await api.default.ensureTrackRemote(projectId)
      if (res?.remote) setRemote(res.remote)
    } catch { /* leave the default remote name */ }
  }

  function copy() {
    void navigator.clipboard?.writeText(cmd)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <SettingsPopover
      label="Check out this branch locally"
      icon={<GitBranch className="w-3.5 h-3.5" />}
      chevron
      width={340}
      fitContent
      onOpen={ensure}
    >
      <SettingsGroupLabel className="mb-1.5">Check out locally</SettingsGroupLabel>
      <p className="text-[11px] text-gray-500 dark:text-gray-400 mb-2 leading-snug">
        Follow this agent's branch from your own checkout. Run it once, then <code className="font-mono">git pull</code> to update as the agent commits.
      </p>
      <div className="flex items-center gap-1.5">
        <code className="flex-1 min-w-0 truncate font-mono text-[11px] bg-gray-100 dark:bg-gray-900 rounded px-2 py-1 text-gray-700 dark:text-gray-200" title={cmd}>{cmd}</code>
        <button
          type="button"
          onClick={copy}
          aria-label="Copy command"
          className="p-1 rounded text-gray-500 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 cursor-pointer shrink-0"
        >
          {copied ? <Check className="w-3.5 h-3.5 text-green-500" /> : <Copy className="w-3.5 h-3.5" />}
        </button>
      </div>
    </SettingsPopover>
  )
}
