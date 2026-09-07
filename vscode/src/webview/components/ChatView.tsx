import { ChevronRight, CircleHelp, File, FilePenLine, FilePlus2, FileText, GitBranch, GitCommitHorizontal, Globe, Image, ListEnd, MessageSquarePlus, Paperclip, Plus, Search, Send, ShieldAlert, Sparkles, Square, SquareTerminal, Trash2, Users, Wrench, X } from 'lucide-react'
import React, { useEffect, useMemo, useRef, useState, type ComponentType } from 'react'
import { postMessage } from '../bridge'
import { buildQuestionResponse, conversationItems, formatValue, splitAttachments, type Event, type Item, type Projection, type QuestionSpec } from '../model'
import type { Approval, QuestionResult, ViewState } from '../types'
import { Markdown } from './Markdown'
import { Button, IconButton } from './ui'

type Attachment = { path: string; name: string }

export function ChatView({ state, events, projection, subagents, approvals, questionResults, draft, attachments, onRemoveAttachment, onDraftChange, onSend }: {
  state: ViewState; events: Event[]; projection?: Projection; subagents: Record<string, Event[]>; approvals: Approval[]; questionResults: Record<string, QuestionResult>; draft: string; attachments: Attachment[]; onRemoveAttachment: (path: string) => void; onDraftChange: (value: string) => void; onSend: (queued?: boolean) => void
}) {
  const end = useRef<HTMLDivElement>(null)
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }) }, [events, projection?.stream?.text, approvals.length, state.queuedMessages?.length])
  const profileLabel = state.profileLabels?.[state.profile] ?? state.profile
  const pendingLabel = state.pendingProfile ? state.profileLabels?.[state.pendingProfile] ?? state.pendingProfile : undefined
  return <div className="grid min-h-0 flex-1 grid-rows-[1fr_auto]">
    <section className="min-h-0 overflow-y-auto px-3 pt-4 pb-5" aria-label="Conversation"><div className="mx-auto flex w-full max-w-3xl flex-col gap-3">
      {!events.length && !projection?.stream && !state.running && <EmptyChat profile={profileLabel} />}
      <Conversation events={events} projection={projection} subagents={subagents} questionResults={questionResults} />
      {approvals.map(approval => <ApprovalCard key={approval.request_id} approval={approval} />)}
      {state.running && <WorkingIndicator thinking={projection?.stream?.kind === 'thinking'} />}
      {!!state.queuedMessages?.length && <div className="flex flex-col gap-1">{state.queuedMessages.map(message => <Message key={message.id} role="user" text={message.text} dimmed />)}</div>}
      <div ref={end} />
    </div></section>
    <Composer state={state} draft={draft} attachments={attachments} profileLabel={profileLabel} pendingLabel={pendingLabel} onRemoveAttachment={onRemoveAttachment} onDraftChange={onDraftChange} onSend={onSend} />
  </div>
}

function EmptyChat({ profile }: { profile: string }) {
  return <div className="flex min-h-[42vh] flex-col items-center justify-center px-5 text-center"><div className="mb-3 flex size-9 items-center justify-center rounded-xl border border-[var(--hydra-border)] bg-[var(--hydra-surface)] shadow-sm"><Sparkles className="size-4 text-[var(--vscode-descriptionForeground)]" /></div><h1 className="m-0 text-base font-semibold tracking-[-0.01em]">What are we working on?</h1><p className="mt-1.5 max-w-64 text-xs leading-relaxed text-[var(--vscode-descriptionForeground)]">Claude and Codex run locally with the permissions in your {profile || 'active'} profile.</p></div>
}

export function Conversation({ events, projection, subagents, questionResults = {} }: { events: Event[]; projection?: Projection; subagents: Record<string, Event[]>; questionResults?: Record<string, QuestionResult> }) {
  const rows = useMemo(() => groupSteps(conversationItems(events)), [events])
  return <>{rows.map(item => {
    if (item.kind === 'stepGroup') return <StepGroup key={item.key} items={item.items} />
    if (item.kind === 'message') return <Message key={item.key} role={item.role} text={item.text} />
    if (item.kind === 'step') return item.title === 'Reasoning' ? <Thought key={item.key} item={item} /> : <ToolStep key={item.key} item={item} />
    if (item.kind === 'commit') return <CommitChip key={item.key} item={item} />
    if (item.kind === 'subagent') return <Subagent key={item.key} item={item} events={subagents[item.id]} />
    if (item.kind === 'question') return <QuestionCard key={item.key} item={item} result={questionResults[item.requestID]} />
    return <div key={item.key} className="flex items-center gap-2 py-0.5 text-xs text-[var(--vscode-descriptionForeground)]"><span className="h-px w-3 bg-[var(--hydra-border)]" />{item.text}</div>
  })}{projection?.stream?.text && (projection.stream.kind === 'thinking' ? <Thought text={projection.stream.text} streaming /> : <Message role="assistant" text={projection.stream.text} streaming />)}</>
}

type StepGroupItem = { kind: 'stepGroup'; key: string; items: Extract<Item, { kind: 'step' }>[] }
function groupSteps(items: Item[]): (Item | StepGroupItem)[] {
  const rows: (Item | StepGroupItem)[] = []
  for (let index = 0; index < items.length;) {
    const current = items[index]
    if (current.kind !== 'step' || current.title === 'Reasoning') { rows.push(current); index++; continue }
    const steps: Extract<Item, { kind: 'step' }>[] = []
    while (index < items.length && items[index].kind === 'step' && (items[index] as Extract<Item, { kind: 'step' }>).title !== 'Reasoning') steps.push(items[index++] as Extract<Item, { kind: 'step' }>)
    rows.push(steps.length === 1 ? steps[0] : { kind: 'stepGroup', key: `group-${steps[0].key}`, items: steps })
  }
  return rows
}

function Message({ role, text, streaming = false, dimmed = false }: { role: 'user' | 'assistant'; text: string; streaming?: boolean; dimmed?: boolean }) {
  const parsed = splitAttachments(text)
  const content = <>{parsed.text && <Markdown text={parsed.text} />}{parsed.attachments.length > 0 && <AttachmentChips paths={parsed.attachments} />}</>
  if (role === 'user') return <article className={`chat-font ml-auto max-w-[88%] rounded-2xl rounded-br-md bg-[var(--hydra-user-message)] px-3.5 py-2.5 ${dimmed ? 'opacity-55' : ''}`}>{content}</article>
  return <article className="chat-font min-w-0 py-1.5"><Markdown text={parsed.text} />{streaming && <StreamCursor />}</article>
}
function AttachmentChips({ paths }: { paths: string[] }) { return <div className="mt-2 flex flex-wrap gap-1.5">{paths.map(value => <span key={value} className="attachment-chip" title={value}><File className="size-3" /><span className="max-w-40 truncate">{value.split(/[\\/]/).at(-1)}</span></span>)}</div> }
function StreamCursor() { return <span className="ml-1 inline-block h-[1em] w-1 animate-pulse align-[-2px] bg-[var(--vscode-foreground)]" /> }

function Thought({ item, text, streaming = false }: { item?: Extract<Item, { kind: 'step' }>; text?: string; streaming?: boolean }) {
  const value = String(text ?? item?.output ?? '')
  if (streaming) { const tail = value.trim().split('\n').filter(Boolean).slice(-2).join('\n'); return tail ? <div className="px-1 text-xs italic leading-relaxed text-[var(--vscode-descriptionForeground)] whitespace-pre-wrap">{tail}</div> : null }
  if (!value.trim()) return null
  return <details className="thought group"><summary className="flex cursor-pointer list-none items-center gap-1.5 py-1 text-xs text-[var(--vscode-descriptionForeground)]"><span className="font-medium text-[var(--vscode-foreground)]">{item?.status ? `Thought for ${item.status}` : 'Thought'}</span><span className="min-w-0 flex-1 truncate italic opacity-75">{value.trim().split('\n')[0]}</span><ChevronRight className="size-3 shrink-0 transition-transform group-open:rotate-90" /></summary><div className="ml-1 border-l-2 border-[var(--hydra-border)] py-1 pl-3 text-xs italic leading-relaxed text-[var(--vscode-descriptionForeground)] whitespace-pre-wrap">{value}</div></details>
}

function StepGroup({ items }: { items: Extract<Item, { kind: 'step' }>[] }) {
  return <details className="step-group group"><summary className="tool-summary"><ChevronRight className="size-3 shrink-0 transition-transform group-open:rotate-90" /><span className="font-medium text-[var(--vscode-foreground)]">{items.length} steps</span><span className="min-w-0 flex-1 truncate">{summarizeTools(items)}</span>{items.some(item => item.status === 'Running') && <span className="tool-running">Running</span>}</summary><div className="mt-1 flex flex-col gap-1 pl-2">{items.map(item => <ToolStep key={item.key} item={item} />)}</div></details>
}

function ToolStep({ item }: { item: Extract<Item, { kind: 'step' }> }) {
  const Icon = toolIcon(item.title), shell = shellDetails(item)
  return <details className={`tool-step group/tool ${item.error ? 'activity-card-error' : ''}`}><summary className="tool-summary"><ChevronRight className="size-3 shrink-0 transition-transform group-open/tool:rotate-90" /><Icon className="size-3.5 shrink-0 opacity-80" /><span className="shrink-0 font-medium text-[var(--vscode-foreground)]">{displayToolName(item.title)}</span><span className="min-w-0 flex-1 truncate">{shell?.cwd ?? item.summary}</span>{item.status && <span className={item.error ? 'text-[var(--vscode-errorForeground)]' : 'tool-running'}>{item.status}</span>}</summary><div className="border-t border-[var(--hydra-border-subtle)] px-3 py-2.5">{shell ? <ShellDetail command={shell.command} cwd={shell.cwd} output={item.output} /> : <>{item.input !== undefined && <DetailBlock label="Input" value={item.input} />}{item.output !== undefined && <DetailBlock label="Output" value={item.output} />}</>}</div></details>
}
function ShellDetail({ command, cwd, output }: { command: string; cwd?: string; output?: unknown }) { const commands = command.split(/\s+&&\s+/); return <div>{cwd && <div className="mb-1.5 text-3xs text-[var(--vscode-descriptionForeground)]">Working directory: <code>{cwd}</code></div>}<div className="code-panel">{commands.map((part, index) => <div key={`${part}-${index}`} className="flex gap-2"><span className="select-none text-[var(--vscode-descriptionForeground)]">{index === commands.length - 1 && output === undefined ? '>' : '✓'}</span><span>{part}</span></div>)}</div>{output !== undefined && <DetailBlock label="Output" value={output} />}</div> }
function DetailBlock({ label, value }: { label?: string; value: unknown }) { return <div className="not-first:mt-2">{label && <div className="mb-1 text-3xs font-medium text-[var(--vscode-descriptionForeground)]">{label}</div>}<pre className="code-panel">{formatValue(value)}</pre></div> }
function CommitChip({ item }: { item: Extract<Item, { kind: 'commit' }> }) { return <div className="flex"><span className="commit-chip"><GitCommitHorizontal className="size-3.5" /><code>{item.sha}</code><span className="max-w-80 truncate">{item.subject}</span>{item.additions !== undefined && <span className="text-[var(--vscode-gitDecoration-addedResourceForeground,#2ea043)]">+{item.additions}</span>}{item.deletions !== undefined && <span className="text-[var(--vscode-gitDecoration-deletedResourceForeground,#f85149)]">-{item.deletions}</span>}</span></div> }

function Subagent({ item, events }: { item: Extract<Item, { kind: 'subagent' }>; events?: Event[] }) {
  const [requested, setRequested] = useState(false)
  return <details className="tool-step group ml-3" onToggle={event => { if (event.currentTarget.open && !requested) { setRequested(true); postMessage({ type: 'loadSubagent', agentID: item.id }) } }}><summary className="tool-summary"><ChevronRight className="size-3 transition-transform group-open:rotate-90" /><Users className="size-3.5" /><span className="min-w-0 flex-1 truncate font-medium text-[var(--vscode-foreground)]">{item.title}</span><span>{sentenceCase(item.status)}</span></summary><div className="border-t border-[var(--hydra-border-subtle)] px-3 py-2.5">{item.prompt && <p className="mt-0 text-xs text-[var(--vscode-descriptionForeground)]">{item.prompt}</p>}{events ? <div className="flex flex-col gap-3"><Conversation events={events} subagents={{}} /></div> : <p className="m-0 text-xs text-[var(--vscode-descriptionForeground)]">{requested ? 'Loading transcript...' : 'Expand to load transcript'}</p>}</div></details>
}

function ApprovalCard({ approval }: { approval: Approval }) {
  const answer = (decision: 'allow' | 'deny', scope: 'once' | 'chat' | 'workspace' | 'profile') => postMessage({ type: 'approval', requestID: approval.request_id, decision, scope })
  return <article className="rounded-xl border border-[var(--vscode-inputValidation-warningBorder)] bg-[var(--vscode-inputValidation-warningBackground)] p-3"><div className="flex items-start gap-2.5"><ShieldAlert className="mt-0.5 size-4 shrink-0" /><div className="min-w-0 flex-1"><strong className="text-xs">{approval.summary}</strong><p className="my-1.5 text-xs leading-relaxed text-[var(--vscode-descriptionForeground)]">{approval.reason}</p><code className="block overflow-wrap-anywhere rounded-md bg-[var(--hydra-code)] px-2 py-1.5 text-3xs">{approval.canonical_target ?? approval.target}</code></div></div><div className="mt-3 flex flex-wrap gap-1.5"><Button onClick={() => answer('allow', 'once')}>Allow once</Button><Button variant="secondary" onClick={() => answer('allow', 'chat')}>Chat</Button><Button variant="secondary" onClick={() => answer('allow', 'workspace')}>Workspace</Button><Button variant="secondary" onClick={() => answer('allow', 'profile')}>Profile</Button><Button variant="ghost" onClick={() => answer('deny', 'once')}>Deny</Button></div></article>
}

function QuestionCard({ item, result }: { item: Extract<Item, { kind: 'question' }>; result?: QuestionResult }) {
  const [answers, setAnswers] = useState<Record<string, string[]>>({}), [other, setOther] = useState<Record<string, string>>({}), [notes, setNotes] = useState<Record<string, string>>({}), [noteOpen, setNoteOpen] = useState<Record<string, boolean>>({}), [submitted, setSubmitted] = useState(false)
  const active = item.active && !submitted
  const toggle = (question: QuestionSpec, label: string) => setAnswers(current => { const selected = current[question.question] ?? []; const next = question.multiSelect ? selected.includes(label) ? selected.filter(value => value !== label) : [...selected, label] : [label]; if (!question.multiSelect) setOther(values => ({ ...values, [question.question]: '' })); return { ...current, [question.question]: next } })
  useEffect(() => { if (result?.error) setSubmitted(false) }, [result])
  const complete = item.questions.every(question => (answers[question.question]?.length ?? 0) > 0 || Boolean(other[question.question]?.trim()))
  const submit = () => { const response = buildQuestionResponse(item.requestID, item.questions, answers, other, notes); if (!response) return; postMessage({ type: 'controlResponse', operationRequestID: `question-response:${item.requestID}`, response }); setSubmitted(true) }
  if (item.answer) return <details className="question-card group"><summary className="flex cursor-pointer list-none items-center gap-2 text-xs"><CircleHelp className="size-3.5 text-[var(--hydra-accent)]" /><span className="font-medium">Question answered</span><ChevronRight className="ml-auto size-3 transition-transform group-open:rotate-90" /></summary><pre className="code-panel mt-2">{item.answer}</pre></details>
  return <article className="question-card">{item.questions.map((question, index) => <fieldset key={question.question} disabled={!active} className="m-0 border-0 p-0 not-first:mt-4"><legend className="mb-2 flex w-full items-start gap-2 text-xs font-medium">{question.header && <span className="question-badge">{question.header}</span>}<span>{question.question}</span></legend><div className="flex flex-col gap-1.5">{question.options.map(option => { const selected = (answers[question.question] ?? []).includes(option.label); return <label className={`question-option ${selected ? 'question-option-selected' : ''}`} key={option.label}><input className="sr-only" type={question.multiSelect ? 'checkbox' : 'radio'} name={`${item.requestID}-${index}`} checked={selected} onChange={() => toggle(question, option.label)} /><span className={`question-check ${question.multiSelect ? 'rounded-[3px]' : 'rounded-full'} ${selected ? 'question-check-selected' : ''}`}>{selected && <span className={`size-1.5 bg-current ${question.multiSelect ? 'rounded-[1px]' : 'rounded-full'}`} />}</span><span className="flex min-w-0 flex-col gap-0.5"><strong className="font-medium">{option.label}</strong>{option.description && <small className="text-3xs leading-relaxed text-[var(--vscode-descriptionForeground)]">{option.description}</small>}</span></label> })}<label className={`question-option ${other[question.question] ? 'question-option-selected' : ''}`}><span className="text-xs font-medium">{question.options.length ? 'Other' : 'Answer'}</span><input className="min-w-0 flex-1! border-0! bg-transparent! p-0!" value={other[question.question] ?? ''} onChange={event => { const value = event.target.value; setOther(current => ({ ...current, [question.question]: value })); if (value && !question.multiSelect) setAnswers(current => ({ ...current, [question.question]: [] })) }} /></label></div><button type="button" className="mt-1.5 inline-flex items-center gap-1 text-3xs text-[var(--vscode-descriptionForeground)] hover:text-[var(--vscode-foreground)]" onClick={() => setNoteOpen(current => ({ ...current, [question.question]: !current[question.question] }))}><MessageSquarePlus className="size-3" />Add note</button>{noteOpen[question.question] && <textarea className="mt-1.5" rows={2} placeholder="Optional context" value={notes[question.question] ?? ''} onChange={event => setNotes(current => ({ ...current, [question.question]: event.target.value }))} />}</fieldset>)}{item.expired && <p className="mb-0 text-xs text-[var(--vscode-descriptionForeground)]">This question expired.</p>}{result?.error && !submitted && <p className="mb-0 text-xs text-[var(--vscode-errorForeground)]">{result.error}</p>}{active && <div className="mt-3 flex justify-end"><Button disabled={!complete} onClick={submit}>{item.questions.length > 1 ? 'Submit all' : 'Submit'}</Button></div>}</article>
}

function WorkingIndicator({ thinking }: { thinking: boolean }) {
  const [elapsed, setElapsed] = useState(0), [verb] = useState(() => WORKING_VERBS[Math.floor(Math.random() * WORKING_VERBS.length)])
  useEffect(() => { const started = Date.now(), timer = window.setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000); return () => window.clearInterval(timer) }, [])
  return <div className="flex min-w-0 items-center gap-1.5 px-1 text-2xs whitespace-nowrap"><Sparkles className="size-3.5 text-[var(--hydra-accent)]" /><span className="chat-text-shimmer shrink-0 font-medium">{verb}...</span><span className="min-w-0 truncate tabular-nums text-[var(--vscode-descriptionForeground)]">({elapsed}s{thinking ? ' · Thinking...' : ''})</span></div>
}

function Composer({ state, draft, attachments, profileLabel, pendingLabel, onRemoveAttachment, onDraftChange, onSend }: { state: ViewState; draft: string; attachments: Attachment[]; profileLabel: string; pendingLabel?: string; onRemoveAttachment: (path: string) => void; onDraftChange: (value: string) => void; onSend: (queued?: boolean) => void }) {
  const profile = state.profileValues?.[state.profile] ?? {}, provider = profile.provider ?? 'codex'
  const models = provider === 'claude' ? ['fable', 'claude-opus-5', 'claude-opus-4-8', 'sonnet', 'haiku'] : ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini']
  const [model, setModel] = useState(profile.model || models[0])
  useEffect(() => setModel(profile.model || models[0]), [state.profile, profile.model, provider])
  const ready = Boolean(draft.trim() || attachments.length)
  return <div className="px-2.5 pb-2.5"><div className="composer mx-auto max-w-3xl">{!!attachments.length && <div className="flex flex-wrap gap-1.5 px-3 pt-2.5">{attachments.map(file => <span key={file.path} className="attachment-chip" title={file.path}><Paperclip className="size-3" /><span className="max-w-36 truncate">{file.name}</span><button aria-label={`Remove ${file.name}`} onClick={() => onRemoveAttachment(file.path)}><X className="size-3" /></button></span>)}</div>}<textarea className="min-h-18 w-full resize-y border-0! bg-transparent! px-3! pt-2.5! pb-1! outline-none" value={draft} rows={3} placeholder="Ask Hydra..." aria-label="Chat message" onChange={event => onDraftChange(event.target.value)} onKeyDown={event => { if (event.key === 'Tab' && event.shiftKey) { event.preventDefault(); postMessage({ type: 'cycleProfile' }) } if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); onSend(state.running) } }} /><div className="flex items-center gap-1.5 px-2 pb-2 text-3xs text-[var(--vscode-descriptionForeground)]"><IconButton label="Attach files" onClick={() => postMessage({ type: 'pickFiles' })}><Plus className="size-4" /></IconButton><button className="min-w-0 truncate rounded px-1 py-0.5 font-medium hover:bg-[var(--vscode-toolbar-hoverBackground)] hover:text-[var(--vscode-foreground)]" onClick={() => postMessage({ type: 'cycleProfile' })}>{pendingLabel ? `${profileLabel} -> ${pendingLabel}` : profileLabel || 'Profile'}</button><span className="flex-1" />{state.running && <span className="hidden whitespace-nowrap min-[440px]:inline"><kbd>Enter</kbd> to queue</span>}<select className="model-select" aria-label="Model" value={model} onChange={event => { setModel(event.target.value); postMessage({ type: 'selectModel', model: event.target.value }) }}>{models.map(value => <option key={value}>{value}</option>)}</select>{state.running && <><IconButton label="Stop response" className="text-[var(--vscode-errorForeground)]" onClick={() => postMessage({ type: 'interrupt' })}><Square className="size-3 fill-current" /></IconButton><Button variant="secondary" className="size-7 px-0" disabled={!ready} onClick={() => onSend(false)} aria-label="Send immediately"><Send className="size-3.5" /></Button><Button className="size-7 px-0" disabled={!ready} onClick={() => onSend(true)} aria-label="Queue message"><ListEnd className="size-3.5" /></Button></>}{!state.running && <Button className="size-7 px-0" disabled={!ready} onClick={() => onSend(false)} aria-label="Send message"><Send className="size-3.5" /></Button>}</div></div></div>
}

function shellDetails(item: Extract<Item, { kind: 'step' }>): { command: string; cwd?: string } | undefined { if (!/bash|terminal|shell/i.test(item.title) || !item.input || typeof item.input !== 'object') return undefined; const input = item.input as Record<string, unknown>, command = typeof input.command === 'string' ? input.command : ''; if (!command) return undefined; const cwd = typeof input.cwd === 'string' ? input.cwd : typeof input.workdir === 'string' ? input.workdir : undefined; return { command, cwd } }
function summarizeTools(items: Extract<Item, { kind: 'step' }>[]): string { const counts = new Map<string, number>(); for (const item of items) { const name = displayToolName(item.title); counts.set(name, (counts.get(name) ?? 0) + 1) } return [...counts].map(([name, count]) => count > 1 ? `${name} x${count}` : name).join(' · ') }
function displayToolName(name: string): string { return name.replaceAll('_', ' ').replace(/\b\w/g, value => value.toUpperCase()) }
function sentenceCase(value: string): string { return value ? value[0].toUpperCase() + value.slice(1).replaceAll('_', ' ') : value }
function toolIcon(name: string): ComponentType<{ className?: string }> { const value = name.toLowerCase(); if (value.includes('bash') || value.includes('shell') || value.includes('terminal')) return SquareTerminal; if (value.includes('view') && value.includes('image')) return Image; if (value.includes('write')) return FilePlus2; if (value.includes('edit')) return FilePenLine; if (value.includes('read')) return FileText; if (value.includes('search') || value.includes('grep') || value.includes('glob') || value === 'ls') return Search; if (value.includes('fetch') || value.includes('web')) return Globe; if (value.includes('delete')) return Trash2; if (value.includes('git')) return GitBranch; return Wrench }
const WORKING_VERBS = ['Brewing', 'Coalescing', 'Conjuring', 'Crafting', 'Deciphering', 'Distilling', 'Forging', 'Hatching', 'Mulling', 'Percolating', 'Pondering', 'Scheming', 'Synthesizing', 'Unfurling', 'Wrangling']
