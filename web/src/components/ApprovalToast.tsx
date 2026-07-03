import React from 'react'
import { Link } from '@tanstack/react-router'
import { Server, SquareTerminal, Globe, Network, Bot, Shield, Check, X } from 'lucide-react'
import type { ApprovalToastData, ToastAction } from '../stores/toastStore'
import { IconButton } from './IconButton'
import { CrossProjectBanner } from './CrossProjectBanner'

// The rich security-gate approval card (replaces the plain toast body for gated
// tool calls). It names exactly what's being requested — a whole MCP server, a
// specific tool call (with a read/write badge and its JSON arguments), or an
// outbound fetch (with the host and URL) — plus the requesting agent, which is
// clickable to jump to it, including when it runs in another project.

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

// A monospace chip for a server / host / command reference embedded in the body.
const Chip: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <span className="inline-flex items-center rounded-md border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/60 px-1.5 py-0.5 font-mono text-[12px] text-gray-700 dark:text-gray-200">
    {children}
  </span>
)

// The MCP server name, tinted violet so the SAME server reads identically across
// the "Allow MCP server" card and the "Run MCP tool" card (which share the violet
// MCP identity). Kept in sync with the mcp_tool badge/icon tone.
const ServerName: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <span className="text-violet-600 dark:text-violet-300">{children}</span>
)

// ChipClause keeps a chip and the punctuation right after it on the same line, so a
// trailing "." or "," never orphans onto a line of its own when the chip wraps.
const ChipClause: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <span className="whitespace-nowrap">{children}</span>
)

// Per-kind visual identity: icon, its tinted square, the card title, and the
// kind/RW badge.
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
        // WRITE is the risky one — flag it in the amber/warning tone; READ stays a
        // calm teal.
        badge: data.rw ? { text: read ? 'READ' : 'WRITE', tone: read ? 'teal' : 'amber' } : null,
      }
    }
    case 'webfetch':
      return { Icon: Globe, iconWrap: 'bg-teal-50 text-teal-600 dark:bg-teal-500/15 dark:text-teal-300', title: 'Web fetch', badge: { text: 'NETWORK', tone: 'teal' } }
    case 'egress':
      return { Icon: Network, iconWrap: 'bg-teal-50 text-teal-600 dark:bg-teal-500/15 dark:text-teal-300', title: 'Allow network host', badge: { text: 'NETWORK', tone: 'teal' } }
    default:
      return { Icon: SquareTerminal, iconWrap: 'bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-300', title: 'Run command', badge: { text: 'SHELL', tone: 'gray' } }
  }
}

// The "An agent wants to <verb> <chip>" body line. The agent isn't named here
// (its clickable subtitle carries that); this states plainly what it's asking to
// do, with the server/tool/host moved inline as a chip.
const BodyLine: React.FC<{ data: ApprovalToastData }> = ({ data }) => {
  switch (data.kind) {
    case 'mcp':
      return <>An agent wants to connect to MCP server <ChipClause><Chip><ServerName>{data.target}</ServerName></Chip>.</ChipClause></>
    case 'mcp_tool': {
      const [server, ...rest] = data.target.split('__')
      const tool = rest.join('__')
      return <>An agent wants to run <ChipClause><Chip><ServerName>{server}</ServerName> <span className="px-0.5 text-gray-400 dark:text-gray-500">▸</span> {tool}</Chip>.</ChipClause></>
    }
    case 'webfetch':
      return <>An agent wants to fetch from <ChipClause><Chip>{data.target}</Chip>.</ChipClause></>
    case 'egress':
      return <>An agent wants to connect to <ChipClause><Chip>{data.target}</Chip>,</ChipClause> which isn&rsquo;t on its network allow-list.</>
    default:
      return <>An agent wants to run <ChipClause><Chip>{data.target}</Chip>.</ChipClause></>
  }
}

// JSON_TOKEN matches the four highlightable pieces of pretty-printed JSON: an
// object key (a string immediately followed by a colon), any other string, a
// keyword (true/false/null), and a number.
const JSON_TOKEN = /("(?:\\.|[^"\\])*"\s*:)|("(?:\\.|[^"\\])*")|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g

// highlightJson splits pretty JSON into tinted spans (keys / strings / keywords /
// numbers), leaving punctuation and whitespace as plain text.
function highlightJson(pretty: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = []
  let last = 0
  let i = 0
  let m: RegExpExecArray | null
  JSON_TOKEN.lastIndex = 0
  while ((m = JSON_TOKEN.exec(pretty)) !== null) {
    if (m.index > last) nodes.push(pretty.slice(last, m.index))
    const tok = m[0]
    const cls = m[1]
      ? 'text-sky-600 dark:text-sky-300'          // key
      : m[2]
        ? 'text-emerald-600 dark:text-emerald-300' // string value
        : m[3]
          ? 'text-purple-600 dark:text-purple-300' // true / false / null
          : 'text-amber-600 dark:text-amber-300'   // number
    nodes.push(<span key={i++} className={cls}>{tok}</span>)
    last = m.index + tok.length
  }
  if (last < pretty.length) nodes.push(pretty.slice(last))
  return nodes
}

// JsonPreview pretty-prints + highlights a compact JSON string. A value that
// doesn't parse (e.g. a truncated preview) is shown verbatim.
const JsonPreview: React.FC<{ raw: string }> = ({ raw }) => {
  let pretty: string
  try {
    pretty = JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    return <span className="text-gray-500 dark:text-gray-400 break-all">{raw}</span>
  }
  return <>{highlightJson(pretty)}</>
}

// The mono preview box: the tool call's JSON arguments (mcp_tool) or the full
// request URL (webfetch). mcp / bash asks have nothing to preview.
const Preview: React.FC<{ data: ApprovalToastData }> = ({ data }) => {
  if (data.kind === 'mcp_tool') {
    return (
      <pre className="max-h-40 overflow-auto rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50/70 dark:bg-gray-900/50 px-3 py-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-all">
        {data.argsPreview ? <JsonPreview raw={data.argsPreview} /> : <span className="text-gray-400 dark:text-gray-500">(no arguments)</span>}
      </pre>
    )
  }
  if (data.kind === 'webfetch' && data.url) {
    return (
      <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50/70 dark:bg-gray-900/50 px-3 py-2 font-mono text-[12px] break-all text-gray-600 dark:text-gray-300">
        {stripScheme(data.url)}
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
  const base = 'inline-flex items-center gap-1 text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors cursor-pointer'
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
  // The subtitle links through to the requesting agent (when we know where it
  // lives). Navigating leaves the approval pending — it does NOT dismiss the card
  // (a non-silent dismiss would deny the call). A real <Link> also lets
  // middle/Ctrl-click open the agent in a new tab.
  const agentTarget = data.agentId && data.projectId
    ? { projectId: data.projectId, agentId: data.agentId }
    : undefined
  return (
    <div
      role="alertdialog"
      aria-label={title}
      className="relative w-[22rem] overflow-hidden rounded-2xl bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 shadow-xl"
    >
      {data.crossProject && <CrossProjectBanner project={data.crossProject} tone="warning" />}
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
              agentTarget ? (
                <Link
                  to="/project/$projectId/agent/$agentId"
                  params={agentTarget}
                  title="Open this agent"
                  className="flex max-w-full items-center gap-1 text-[11px] text-gray-500 dark:text-gray-400 transition-colors cursor-pointer hover:text-gray-800 hover:underline dark:hover:text-gray-200"
                >
                  <Bot className="w-3 h-3 shrink-0" />
                  <span className="truncate">{data.agentName}</span>
                </Link>
              ) : (
                // No known location for the agent — render the name as plain,
                // non-interactive text (no link, no hover affordance).
                <span className="flex max-w-full items-center gap-1 text-[11px] text-gray-500 dark:text-gray-400">
                  <Bot className="w-3 h-3 shrink-0" />
                  <span className="truncate">{data.agentName}</span>
                </span>
              )
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
          {data.kind === 'mcp' && (
            <Caption icon={<Shield className="w-3 h-3" />}>You&rsquo;ll still approve individual tools the first time the agent calls them.</Caption>
          )}
          {data.kind === 'webfetch' && (
            <Caption icon={<Globe className="w-3 h-3" />}>
              Allowing trusts the whole host — every request to <span className="font-mono">{data.target}</span>, including POSTs — not just this URL.
            </Caption>
          )}
          {data.kind === 'egress' && (
            <Caption icon={<Network className="w-3 h-3" />}>
              Allow once opens <span className="font-mono">{data.target}</span> for the rest of this session; Always allow adds it to the agent&rsquo;s network allow-list.
            </Caption>
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
