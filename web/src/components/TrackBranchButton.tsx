import { useState } from 'react'
import { MonitorDown } from 'lucide-react'
import { SettingsPopover, SettingsGroupLabel } from './SettingsPopover'
import { api } from '../stores/apiClient'
import { copyWithToast } from '../lib/copyToast'
import { useCopyFlash } from '../lib/useCopyFlash'
import { CopyStateIcon } from './CopyStateIcon'

// TrackBranchButton is the small icon+chevron button in the agent header that
// opens a popover explaining how to check out and follow this head's branch from
// the user's own repo. On open it ensures the project's `hydra-agents` remote
// exists (a daemon action), so the shown command is just a `git checkout -t` -
// no long remote-setup incantation. The chevron marks it as a menu, not an action.
// The icon is a monitor-with-down-arrow rather than a branch glyph: the header
// already carries git-ish marks, and the action here is "pull this onto my own
// machine", not "look at a branch".
export function TrackBranchButton({ projectId, agentId }: { projectId: string; agentId: string }) {
  const [remote, setRemote] = useState('hydra-agents')
  const { state, flash } = useCopyFlash()
  const cmd = `git checkout -t ${remote}/${agentId}`

  // Set up the remote lazily when the popover opens. If it fails, the default
  // name still makes a valid command once the remote is configured by hand.
  async function ensure() {
    try {
      const res = await api.default.ensureTrackRemote(projectId)
      if (res?.remote) setRemote(res.remote)
    } catch { /* leave the default remote name */ }
  }

  // Copy via the shared toast helper: the icon flashes a tick/X, and the toast
  // shows the command that landed on the clipboard. copyWithToast goes through
  // copyText, so this also works on the insecure LAN origins where
  // navigator.clipboard is undefined and the old writeText silently no-opped.
  function copy() {
    void copyWithToast(cmd, { what: 'checkout command', lang: 'bash' }).then(flash)
  }

  return (
    <SettingsPopover
      label="Check out this branch locally"
      icon={<MonitorDown className="w-3.5 h-3.5" />}
      chevron
      width={340}
      fitContent
      onOpen={ensure}
    >
      <SettingsGroupLabel className="mb-1.5">Check out locally</SettingsGroupLabel>
      <p className="text-2xs text-gray-500 dark:text-gray-400 mb-2 leading-snug">
        Follow this agent's branch from your own checkout. Run it once, then <code className="font-mono">git pull</code> to update as the agent commits.
      </p>
      {/* items-start, not items-center: the command box wraps to as many lines as
          it needs, so the copy button stays level with its first line instead of
          drifting to the middle of a tall box. */}
      <div className="flex items-start gap-1.5">
        {/* The command WRAPS rather than truncating with an ellipsis (and carries
            no native title): a checkout command you can't read in full is no use,
            and a long agent id made the ellipsis eat the branch name - the part
            you actually want to see. break-words, not break-all: normal wrapping
            already breaks a head id at its hyphens, which reads far better than
            a break mid-word, and this only steps in for a token with nowhere to
            break rather than overflowing the box. */}
        <code className="flex-1 min-w-0 break-words font-mono text-2xs bg-gray-100 dark:bg-gray-900 rounded px-2 py-1 text-gray-700 dark:text-gray-200">{cmd}</code>
        <button
          type="button"
          onClick={copy}
          aria-label="Copy command"
          className="p-1 rounded text-gray-500 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 cursor-pointer shrink-0"
        >
          <CopyStateIcon state={state} />
        </button>
      </div>
    </SettingsPopover>
  )
}
