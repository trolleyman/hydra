import { Bot, Brain, ChevronRight, CircleHelp, Send, ShieldAlert, Sparkles, Square, Terminal, Users } from 'lucide-react'
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { postMessage } from '../bridge'
import { buildQuestionResponse, conversationItems, formatValue, type Event, type Item, type Projection, type QuestionSpec } from '../model'
import type { Approval, QuestionResult, ViewState } from '../types'
import { Markdown } from './Markdown'
import { Button } from './ui'

export function ChatView({ state, events, projection, subagents, approvals, questionResults, draft, onDraftChange, onSend }: {
  state: ViewState
  events: Event[]
  projection?: Projection
  subagents: Record<string, Event[]>
  approvals: Approval[]
  questionResults: Record<string, QuestionResult>
  draft: string
  onDraftChange: (value: string) => void
  onSend: () => void
}) {
  const end = useRef<HTMLDivElement>(null)
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }) }, [events, projection?.stream?.text, approvals.length])
  const profileLabel = state.profileLabels?.[state.profile] ?? state.profile
  const pendingLabel = state.pendingProfile ? state.profileLabels?.[state.pendingProfile] ?? state.pendingProfile : undefined

  return <div className="grid min-h-0 flex-1 grid-rows-[1fr_auto]">
    <section className="min-h-0 overflow-y-auto px-3 pt-4 pb-5" aria-label="Conversation">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-3">
        {!events.length && !projection?.stream && <EmptyChat profile={profileLabel} />}
        <Conversation events={events} projection={projection} subagents={subagents} questionResults={questionResults} />
        {approvals.map(approval => <ApprovalCard key={approval.request_id} approval={approval} />)}
        <div ref={end} />
      </div>
    </section>
    <Composer state={state} draft={draft} profileLabel={profileLabel} pendingLabel={pendingLabel} onDraftChange={onDraftChange} onSend={onSend} />
  </div>
}

function EmptyChat({ profile }: { profile: string }) {
  return <div className="flex min-h-[42vh] flex-col items-center justify-center px-5 text-center">
    <div className="mb-3 flex size-9 items-center justify-center rounded-xl border border-[var(--hydra-border)] bg-[var(--hydra-surface)] shadow-sm"><Sparkles className="size-4 text-[var(--vscode-descriptionForeground)]" /></div>
    <h1 className="m-0 text-base font-semibold tracking-[-0.01em]">What are we working on?</h1>
    <p className="mt-1.5 max-w-64 text-xs leading-relaxed text-[var(--vscode-descriptionForeground)]">Claude and Codex run locally with the permissions in your {profile || 'active'} profile.</p>
  </div>
}

export function Conversation({ events, projection, subagents, questionResults = {} }: { events: Event[]; projection?: Projection; subagents: Record<string, Event[]>; questionResults?: Record<string, QuestionResult> }) {
  const items = useMemo(() => conversationItems(events), [events])
  return <>{items.map(item => {
    if (item.kind === 'message') return <Message key={item.key} role={item.role} text={item.text} />
    if (item.kind === 'step') return <Step key={item.key} item={item} />
    if (item.kind === 'subagent') return <Subagent key={item.key} item={item} events={subagents[item.id]} />
    if (item.kind === 'question') return <QuestionCard key={item.key} item={item} result={questionResults[item.requestID]} />
    return <div key={item.key} className="flex items-center gap-2 py-0.5 text-xs text-[var(--vscode-descriptionForeground)]"><span className="h-px w-3 bg-[var(--hydra-border)]" />{item.text}</div>
  })}{projection?.stream?.text && <Message role="assistant" text={projection.stream.text} streaming kind={projection.stream.kind} />}</>
}

function Message({ role, text, streaming = false, kind }: { role: 'user' | 'assistant'; text: string; streaming?: boolean; kind?: string }) {
  if (role === 'user') return <article className="ml-auto max-w-[88%] rounded-2xl rounded-br-md bg-[var(--hydra-user-message)] px-3.5 py-2.5 text-[var(--vscode-foreground)]"><Markdown text={text} /></article>
  if (kind === 'thinking') return <div className="flex items-start gap-2 py-1 text-xs italic text-[var(--vscode-descriptionForeground)]"><Brain className="mt-0.5 size-3.5 shrink-0" /><div className="line-clamp-3 whitespace-pre-wrap">{text}</div>{streaming && <StreamCursor />}</div>
  return <article className="group flex min-w-0 gap-2.5 py-1.5"><div className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-md bg-[var(--hydra-accent-soft)] text-[var(--vscode-textLink-foreground)]"><Bot className="size-3.5" /></div><div className="min-w-0 flex-1"><Markdown text={text} />{streaming && <StreamCursor />}</div></article>
}

function StreamCursor() { return <span className="ml-1 inline-block h-[1em] w-1 animate-pulse align-[-2px] bg-[var(--vscode-foreground)]" /> }

function Step({ item }: { item: Extract<Item, { kind: 'step' }> }) {
  const reasoning = item.title === 'Reasoning'
  const Icon = reasoning ? Brain : Terminal
  return <details className={`activity-card group ${item.error ? 'activity-card-error' : ''}`}>
    <summary className="flex cursor-pointer list-none items-center gap-2 px-2.5 py-1.5 text-xs text-[var(--vscode-descriptionForeground)] transition-colors hover:text-[var(--vscode-foreground)]">
      <ChevronRight className="size-3 shrink-0 transition-transform group-open:rotate-90" />
      <Icon className="size-3.5 shrink-0 opacity-80" />
      <span className="min-w-0 flex-1 truncate font-medium">{reasoning ? 'Thought' : item.title}</span>
      {item.status && <span className="shrink-0 text-3xs opacity-80">{item.status}</span>}
    </summary>
    <div className="border-t border-[var(--hydra-border-subtle)] px-3 pt-2 pb-2.5">
      {item.input !== undefined && <DetailBlock label={reasoning ? undefined : 'Input'} value={item.input} prose={reasoning} />}
      {item.output !== undefined && <DetailBlock label={reasoning ? undefined : 'Output'} value={item.output} prose={reasoning} />}
    </div>
  </details>
}

function DetailBlock({ label, value, prose = false }: { label?: string; value: unknown; prose?: boolean }) {
  return <div className="not-first:mt-2">{label && <div className="mb-1 text-3xs font-medium text-[var(--vscode-descriptionForeground)]">{label}</div>}{prose ? <div className="border-l-2 border-[var(--hydra-border)] pl-2.5 text-xs italic leading-relaxed text-[var(--vscode-descriptionForeground)] whitespace-pre-wrap">{String(value ?? '')}</div> : <pre className="code-panel">{formatValue(value)}</pre>}</div>
}

function Subagent({ item, events }: { item: Extract<Item, { kind: 'subagent' }>; events?: Event[] }) {
  const [requested, setRequested] = useState(false)
  return <details className="activity-card group ml-3" onToggle={event => {
    if (event.currentTarget.open && !requested) {
      setRequested(true)
      postMessage({ type: 'loadSubagent', agentID: item.id })
    }
  }}>
    <summary className="flex cursor-pointer list-none items-center gap-2 px-2.5 py-1.5 text-xs text-[var(--vscode-descriptionForeground)] transition-colors hover:text-[var(--vscode-foreground)]">
      <ChevronRight className="size-3 shrink-0 transition-transform group-open:rotate-90" /><Users className="size-3.5 shrink-0" /><span className="min-w-0 flex-1 truncate font-medium">{item.title}</span><span className="text-3xs">{item.status}</span>
    </summary>
    <div className="border-t border-[var(--hydra-border-subtle)] px-3 py-2.5">{item.prompt && <p className="mt-0 text-xs text-[var(--vscode-descriptionForeground)]">{item.prompt}</p>}{events ? <div className="flex flex-col gap-3"><Conversation events={events} subagents={{}} /></div> : <p className="m-0 text-xs text-[var(--vscode-descriptionForeground)]">{requested ? 'Loading transcript...' : 'Expand to load transcript'}</p>}</div>
  </details>
}

function ApprovalCard({ approval }: { approval: Approval }) {
  const answer = (decision: 'allow' | 'deny', scope: 'once' | 'chat' | 'workspace' | 'profile') => postMessage({ type: 'approval', requestID: approval.request_id, decision, scope })
  return <article className="rounded-xl border border-[var(--vscode-inputValidation-warningBorder)] bg-[var(--vscode-inputValidation-warningBackground)] p-3">
    <div className="flex items-start gap-2.5"><ShieldAlert className="mt-0.5 size-4 shrink-0 text-[var(--vscode-inputValidation-warningForeground,var(--vscode-foreground))]" /><div className="min-w-0 flex-1"><strong className="text-xs">{approval.summary}</strong><p className="my-1.5 text-xs leading-relaxed text-[var(--vscode-descriptionForeground)]">{approval.reason}</p><code className="block overflow-wrap-anywhere rounded-md bg-[var(--hydra-code)] px-2 py-1.5 text-3xs">{approval.canonical_target ?? approval.target}</code></div></div>
    <div className="mt-3 flex flex-wrap gap-1.5"><Button onClick={() => answer('allow', 'once')}>Allow once</Button><Button variant="secondary" onClick={() => answer('allow', 'chat')}>Chat</Button><Button variant="secondary" onClick={() => answer('allow', 'workspace')}>Workspace</Button><Button variant="secondary" onClick={() => answer('allow', 'profile')}>Profile</Button><Button variant="ghost" onClick={() => answer('deny', 'once')}>Deny</Button></div>
  </article>
}

function QuestionCard({ item, result }: { item: Extract<Item, { kind: 'question' }>; result?: QuestionResult }) {
  const [answers, setAnswers] = useState<Record<string, string[]>>({})
  const [other, setOther] = useState<Record<string, string>>({})
  const [notes, setNotes] = useState<Record<string, string>>({})
  const [submitted, setSubmitted] = useState(false)
  const active = item.active && !submitted
  const toggle = (question: QuestionSpec, label: string) => setAnswers(current => {
    const selected = current[question.question] ?? []
    const next = question.multiSelect ? selected.includes(label) ? selected.filter(value => value !== label) : [...selected, label] : [label]
    if (!question.multiSelect) setOther(values => ({ ...values, [question.question]: '' }))
    return { ...current, [question.question]: next }
  })
  useEffect(() => { if (result?.error) setSubmitted(false) }, [result])
  const complete = item.questions.every(question => (answers[question.question]?.length ?? 0) > 0 || Boolean(other[question.question]?.trim()))
  const submit = () => {
    const response = buildQuestionResponse(item.requestID, item.questions, answers, other, notes)
    if (!response) return
    postMessage({ type: 'controlResponse', operationRequestID: `question-response:${item.requestID}`, response })
    setSubmitted(true)
  }
  const heading = item.expired ? 'Question expired' : !item.active ? 'Question answered' : submitted ? 'Submitting answers...' : 'Input needed'
  return <article className={`rounded-xl border p-3 ${item.active ? 'border-[var(--vscode-focusBorder)] bg-[var(--hydra-surface)]' : 'border-[var(--hydra-border)] text-[var(--vscode-descriptionForeground)]'}`}>
    <div className="flex items-center gap-2 text-xs font-semibold"><CircleHelp className="size-4 text-[var(--vscode-textLink-foreground)]" />{heading}</div>
    {item.answer ? <pre className="mt-2 mb-0 whitespace-pre-wrap rounded-md bg-[var(--hydra-code)] p-2 text-xs">{item.answer}</pre> : item.questions.map((question, index) => <fieldset key={question.question} disabled={!active} className="m-0 mt-3 border-0 p-0"><legend className="mb-2 flex w-full flex-col gap-1 text-xs font-medium">{question.header && <span className="text-3xs font-normal text-[var(--vscode-descriptionForeground)]">{question.header}</span>}{question.question}</legend><div className="flex flex-col gap-1.5">{question.options.map(option => {
      const selected = (answers[question.question] ?? []).includes(option.label)
      return <label className={`question-option ${selected ? 'question-option-selected' : ''}`} key={option.label}><input className="sr-only" type={question.multiSelect ? 'checkbox' : 'radio'} name={`${item.requestID}-${index}`} checked={selected} onChange={() => toggle(question, option.label)} /><span className={`mt-0.5 flex size-3.5 shrink-0 items-center justify-center border ${question.multiSelect ? 'rounded-[3px]' : 'rounded-full'} ${selected ? 'border-[var(--vscode-focusBorder)] bg-[var(--vscode-focusBorder)]' : 'border-[var(--vscode-checkbox-border,var(--hydra-border))]'}`}>{selected && <span className={`bg-[var(--vscode-button-foreground)] ${question.multiSelect ? 'size-1.5 rounded-[1px]' : 'size-1.5 rounded-full'}`} />}</span><span className="flex min-w-0 flex-col gap-0.5"><strong className="font-medium">{option.label}</strong>{option.description && <small className="text-3xs leading-relaxed text-[var(--vscode-descriptionForeground)]">{option.description}</small>}</span></label>
    })}</div><label className="mt-2 flex flex-col gap-1 text-3xs text-[var(--vscode-descriptionForeground)]"><span>{question.options.length ? 'Other' : 'Answer'}</span><input value={other[question.question] ?? ''} onChange={event => { const value = event.target.value; setOther(current => ({ ...current, [question.question]: value })); if (value && !question.multiSelect) setAnswers(current => ({ ...current, [question.question]: [] })) }} /></label><label className="mt-2 flex flex-col gap-1 text-3xs text-[var(--vscode-descriptionForeground)]"><span>Note (optional)</span><textarea rows={2} value={notes[question.question] ?? ''} onChange={event => setNotes(current => ({ ...current, [question.question]: event.target.value }))} /></label></fieldset>)}
    {result?.error && !submitted && <p className="mb-0 text-xs text-[var(--vscode-errorForeground)]">{result.error}</p>}
    {active && <Button className="mt-3" disabled={!complete} onClick={submit}>Submit answers</Button>}
  </article>
}

function Composer({ state, draft, profileLabel, pendingLabel, onDraftChange, onSend }: { state: ViewState; draft: string; profileLabel: string; pendingLabel?: string; onDraftChange: (value: string) => void; onSend: () => void }) {
  return <div className="px-2.5 pb-2.5">
    <div className="mx-auto max-w-3xl rounded-xl border border-[var(--vscode-input-border,var(--hydra-border-strong))] bg-[var(--vscode-input-background)] shadow-[0_2px_10px_rgb(0_0_0/0.08)] focus-within:border-[var(--vscode-focusBorder)] focus-within:ring-1 focus-within:ring-[var(--vscode-focusBorder)]">
      <textarea className="min-h-20 w-full resize-y bg-transparent px-3 pt-2.5 pb-1 text-[var(--vscode-input-foreground,var(--vscode-foreground))] outline-none placeholder:text-[var(--vscode-input-placeholderForeground)]" value={draft} rows={3} placeholder="Ask Hydra..." aria-label="Chat message" onChange={event => onDraftChange(event.target.value)} onKeyDown={event => {
        if (event.key === 'Tab' && event.shiftKey) { event.preventDefault(); postMessage({ type: 'cycleProfile' }) }
        if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); onSend() }
      }} />
      <div className="flex items-center justify-between gap-2 px-2 pb-2 pl-3 text-3xs text-[var(--vscode-descriptionForeground)]"><button className="min-w-0 truncate rounded px-1 py-0.5 font-medium hover:bg-[var(--vscode-toolbar-hoverBackground)] hover:text-[var(--vscode-foreground)]" onClick={() => postMessage({ type: 'cycleProfile' })} aria-label="Cycle profile with Shift+Tab">{pendingLabel ? `${profileLabel} -> ${pendingLabel} after turn` : profileLabel || 'Profile'}</button>{state.running ? <Button className="size-7 px-0" onClick={() => postMessage({ type: 'interrupt' })} aria-label="Stop response"><Square className="size-3 fill-current" /></Button> : <Button className="size-7 px-0" disabled={!draft.trim()} onClick={onSend} aria-label="Send message"><Send className="size-3.5" /></Button>}</div>
    </div>
  </div>
}
