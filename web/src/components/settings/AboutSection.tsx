import { AppWindow, Database, GitCommitHorizontal, Server } from 'lucide-react'
import type { ReactNode } from 'react'
import { useProjectStore } from '../../stores/projectStore'
import { hasDesktopBridge } from '../../lib/desktopBridge'

function Detail({ icon, label, value, mono = false }: { icon: ReactNode; label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex min-w-0 items-center gap-3 rounded-lg border border-gray-200 bg-gray-50 p-3 dark:border-gray-700 dark:bg-gray-900/50">
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-white text-gray-500 shadow-sm ring-1 ring-gray-200 dark:bg-gray-800 dark:text-gray-400 dark:ring-gray-700">
        {icon}
      </div>
      <div className="min-w-0">
        <div className="text-xs text-gray-500 dark:text-gray-400">{label}</div>
        <div className={`${mono ? 'font-mono text-xs' : 'text-sm'} mt-0.5 truncate font-medium text-gray-900 dark:text-gray-100`} title={value}>
          {value}
        </div>
      </div>
    </div>
  )
}

export function AboutSection() {
  const status = useProjectStore((state) => state.systemStatus)
  const version = status?.version || 'Development build'
  const commit = status?.git_commit || 'Unavailable'
  const platform = status?.runtime_os
    ? ({ linux: 'Linux', windows: 'Windows', darwin: 'macOS' }[status.runtime_os] ?? status.runtime_os)
    : 'Unknown'
  const databaseDirectory = status?.database_directory || 'Unavailable'
  const runtime = hasDesktopBridge() ? 'Desktop app' : 'Web browser'
  const backendOwnership = status?.backend_lifetime === 'command-owned'
    ? 'Command-owned'
    : status?.backend_lifetime === 'persistent' ? 'Standalone' : 'Unknown'

  return (
    <div className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-800">
      <div className="border-b border-gray-200 bg-gradient-to-br from-blue-50 to-indigo-50 px-6 py-8 text-center dark:border-gray-700 dark:from-blue-950/40 dark:to-indigo-950/30">
        <picture>
          <source srcSet="/icon.avif" type="image/avif" />
          <img src="/icon.png" alt="" className="mx-auto h-20 w-20 object-contain drop-shadow-lg" />
        </picture>
        <h1 className="mt-4 text-xl font-semibold text-gray-950 dark:text-white">Hydra</h1>
        <p className="mx-auto mt-2 max-w-lg text-sm leading-6 text-gray-600 dark:text-gray-300">
          An AI orchestration platform for running and reviewing autonomous coding agents in isolated worktrees.
        </p>
      </div>
      <div className="p-4 sm:p-6">
        <h2 className="mb-3 text-sm font-semibold text-gray-900 dark:text-gray-100">Build information</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <Detail icon={<Server className="h-4 w-4" />} label="Version" value={version} mono />
          <Detail icon={<GitCommitHorizontal className="h-4 w-4" />} label="Git commit" value={commit} mono />
          <Detail icon={<AppWindow className="h-4 w-4" />} label="Runtime" value={`${runtime} on ${platform}`} />
          <Detail icon={<Server className="h-4 w-4" />} label="Server status" value={status?.status || 'Connecting...'} />
          <Detail icon={<Server className="h-4 w-4" />} label="Backend ownership" value={backendOwnership} />
          <Detail icon={<Database className="h-4 w-4" />} label="State directory" value={databaseDirectory} mono />
        </div>
      </div>
    </div>
  )
}
