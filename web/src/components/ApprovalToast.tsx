import React from 'react'
import { Server, SquareTerminal, Globe, Bot, Info, Shield, Folder, Check, X } from 'lucide-react'
import type { ApprovalToastData, ToastAction } from '../stores/toastStore'
import { IconButton } from './IconButton'

// The rich security-gate approval card (replaces the plain toast body for gated
// tool calls). It names exactly what's being requested — a whole MCP server, a
// specific tool call (with a read/write badge and an argument preview), or an
// outbound fetch (with the verb and URL) — plus the requesting agent, including
// when it runs in another project.

// A small pill: a tinted, uppercase kind/verb label.
const Badge: React.FC<{ text: string; tone: BadgeTone }> = ({ text, tone }) => (
  <span className={`inline-flex items-center rounded-md px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider ${BADGE_TONES[tone]}`}>
    {text}
  </span>
)

type BadgeTone = 'blue' | 'violet' | 'teal' | 'amber' | 'gray'
const BADGE_TONES: Record<BadgeTone, string> = {
  blue: 'bg-blue-50 text-blue-600 dark:bg-blue-500/15 dark:text-blue-300',
  violet: 'bg-violet-50 text-violet-600 dark:bg-violet-500/15 dark:text-violet-300',
  teal: 'bg-teal-50 text-teal-600 dark:bg-teal-500/15 dark:text-teal-300',
  amber: 'bg-amber-50 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300',
  gray: 'bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-300',
}

// A monospace chip for a server / host / command reference.
const Chip: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <span className="inline-flex items-center rounded-md border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/60 px-1.5 py-0.5 font-mono text-[12px] text-gray-700 dark:text-gray-200">
    {children}
  </span>
)

// Per-kind visual identity: icon, its tinted square, the kind badge, and the body
// verb phrasing.
function kindVisual(data: ApprovalToastData): {
  Icon: React.ComponentType<{ className?: string }>
  iconWrap: string
  title: string
  badge: { text: string; tone: BadgeTone } | null
} {
  switch (data.kind) {
    case 'mcp':
      return { Icon: Server, iconWrap: 'bg-blue-50 text-blue-600 dark:bg-blue-500/15 dark:text-blue-300', title: 'Allow MCP server', badge: { text: 'MCP', tone: 'blue' } }
    case 'mcp_tool': {
      const read = data.rw === 'read'
      return {
        Icon: SquareTerminal,
        iconWrap: 'bg-violet-50 text-violet-600 dark:bg-violet-500/15 dark:text-violet-300',
        title: 'Run MCP tool',
        badge: data.rw ? { text: read ? 'READ' : 'WRITE', tone: read ? 'teal' : 'violet' } : null,
      }
    }
    case 'webfetch':
      return { Icon: Globe, iconWrap: 'bg-teal-50 text-teal-600 dark:bg-teal-500/15 dark:text-teal-300', title: 'Web fetch', badge: { text: 'NETWORK', tone: 'teal' } }
    default:
      return { Icon: SquareTerminal, iconWrap: 'bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-300', title: 'Run command', badge: { text: 'SHELL', tone: 'gray' } }
  }
}

// The "<task> wants to <verb> <chip>" body line.
const BodyLine: React.FC<{ data: ApprovalToastData }> = ({ data }) => {
  const task = data.agentName ? <span className="font-semibold text-gray-900 dark:text-gray-50">“{data.agentName}”</span> : <span className="font-semibold">The agent</span>
  switch (data.kind) {
    case 'mcp':
      return <>{task} wants to connect to MCP server <Chip>{data.target}</Chip>.</>
    case 'mcp_tool':
      return <>{task} wants to call a tool on <Chip>{data.target.split('__')[0]}</Chip>.</>
    case 'webfetch':
      return <>{task} wants to fetch from <Chip>{data.target}</Chip>.</>
    default:
      return <>{task} wants to run <Chip>{data.target}</Chip>.</>
  }
}

// The mono preview box: server ▸ tool + args (mcp_tool), or METHOD + url (webfetch).
const Preview: React.FC<{ data: ApprovalToastData }> = ({ data }) => {
  if (data.kind === 'mcp_tool') {
    const [server, ...rest] = data.target.split('__')
    const tool = rest.join('__')
    return (
      <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50/70 dark:bg-gray-900/50 px-3 py-2 font-mono text-[12px] leading-relaxed">
        <div>
          <span className="text-violet-600 dark:text-violet-300">{server}</span>
          <span className="text-gray-400 px-1">▸</span>
          <span className="font-semibold text-gray-800 dark:text-gray-100">{tool}</span>
        </div>
        {data.argsPreview && <div className="text-gray-400 dark:text-gray-500 break-all">{data.argsPreview}</div>}
      </div>
    )
  }
  if (data.kind === 'webfetch' && data.url) {
    return (
      <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50/70 dark:bg-gray-900/50 px-3 py-2 flex items-center gap-2 font-mono text-[12px]">
        <Badge text="GET" tone="teal" />
        <span className="text-gray-600 dark:text-gray-300 break-all">{stripScheme(data.url)}</span>
      </div>
    )
  }
  return null
}

// A muted caption line with a leading icon.
const Caption: React.FC<{ icon: React.ReactNode; children: React.ReactNode }> = ({ icon, children }) => (
  <div className="flex items-start gap-1.5 text-[11px] text-gray-500 dark:text-gray-400 leading-snug">
    <span className="mt-px shrink-0 text-gray-400 dark:text-gray-500">{icon}</span>
    <span>{children}</span>
  </div>
)

const actionClass = (a: ToastAction): string => {
  const base = 'inline-flex items-center gap-1 text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors'
  if (a.variant === 'danger') return `${base} text-red-600 border border-red-200 hover:bg-red-50 dark:text-red-400 dark:border-red-500/40 dark:hover:bg-red-500/10`
  if (a.variant === 'primary') {
    // The FIRST primary (Allow once) is the solid accent; a second primary
    // (Always allow) is a lighter tint.
    return a.label.toLowerCase().startsWith('always')
      ? `${base} bg-blue-50 text-blue-700 hover:bg-blue-100 dark:bg-blue-500/15 dark:text-blue-300 dark:hover:bg-blue-500/25`
      : `${base} bg-blue-600 text-white hover:bg-blue-500`
  }
  return `${base} bg-gray-100 hover:bg-gray-200 dark:bg-gray-700 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-200`
}

export const ApprovalCard: React.FC<{
  data: ApprovalToastData
  actions: ToastAction[]
  toastId: number
  onDismiss: () => void
}> = ({ data, actions, toastId, onDismiss }) => {
  const { Icon, iconWrap, title, badge } = kindVisual(data)
  return (
    <div
      role="alertdialog"
      aria-label={title}
      className="relative w-[22rem] overflow-hidden rounded-2xl bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 shadow-xl"
    >
      {data.crossProject && (
        <div className="flex items-center gap-2 px-4 py-1.5 bg-amber-50 dark:bg-amber-500/10 border-b border-amber-200/70 dark:border-amber-500/20 text-[10px] font-bold uppercase tracking-wider text-amber-700 dark:text-amber-300">
          <Folder className="w-3 h-3" />
          Running in another project · <span className="font-mono normal-case tracking-normal">{data.crossProject}</span>
        </div>
      )}
      <div className="p-4">
        <div className="flex items-start gap-3">
          <div className={`shrink-0 w-9 h-9 rounded-xl flex items-center justify-center ${iconWrap}`}>
            <Icon className="w-[18px] h-[18px]" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-bold text-gray-900 dark:text-gray-50">{title}</h3>
              {badge && <Badge text={badge.text} tone={badge.tone} />}
            </div>
            {data.agentName && (
              <div className="flex items-center gap-1 text-[11px] text-gray-400 dark:text-gray-500">
                <Bot className="w-3 h-3" />
                <span className="truncate">{data.agentName}</span>
              </div>
            )}
          </div>
          <IconButton onClick={onDismiss}>
            <X className="w-4 h-4" />
          </IconButton>
        </div>

        <p className="mt-3 text-sm text-gray-700 dark:text-gray-200 leading-relaxed">
          <BodyLine data={data} />
        </p>

        <div className="mt-2.5 space-y-2">
          <Preview data={data} />
          {data.reason && <Caption icon={<Info className="w-3 h-3" />}>{data.reason}</Caption>}
          {data.kind === 'mcp' && (
            <Caption icon={<Shield className="w-3 h-3" />}>You&rsquo;ll still approve individual tools the first time the agent calls them.</Caption>
          )}
        </div>

        {actions.length > 0 && (
          <div className="mt-3.5 flex items-center gap-2">
            {actions.map((a) => (
              <button key={a.label} onClick={() => a.onClick(toastId)} className={actionClass(a)}>
                {a.variant === 'primary' && !a.label.toLowerCase().startsWith('always') && <Check className="w-3.5 h-3.5" />}
                {a.label}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// stripScheme drops the http(s):// prefix so the URL reads compactly.
function stripScheme(url: string): string {
  return url.replace(/^https?:\/\//, '')
}
