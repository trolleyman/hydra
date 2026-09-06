import DOMPurify from 'dompurify'
import { marked } from 'marked'
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { components } from '../generated/protocol'
import { buildQuestionResponse, conversationItems, dedupe, foldStream, formatValue, type Event, type Item, type Projection, type QuestionSpec } from './model'
import './style.css'

const vscode = acquireVsCodeApi()
type State = { page: 'chat' | 'history' | 'profiles'; profile: string; pendingProfile?: string; profiles: string[]; profileLabels?: Record<string, string>; profileValues?: Record<string, any>; networkMode?: string; running: boolean; hasConversation: boolean }
type HostFrame = components['schemas']['HostFrame']
type Approval = Extract<HostFrame, { type: 'approval_request' }>

function App() {
  const [state, setState] = useState<State>({ page: 'chat', profile: '', profiles: [], running: false, hasConversation: false })
  const [events, setEvents] = useState<Event[]>([])
  const [projection, setProjection] = useState<Projection>()
  const [history, setHistory] = useState<any[]>([])
  const [subagents, setSubagents] = useState<Record<string, Event[]>>({})
  const [draft, setDraft] = useState(() => String((vscode.getState() as { draft?: string } | undefined)?.draft ?? ''))
  const [error, setError] = useState('')
  const [approvals, setApprovals] = useState<Approval[]>([])
  const [questionResults, setQuestionResults] = useState<Record<string, { error?: string; version: number }>>({})
  const conversationEnd = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const consume = (frame: HostFrame) => {
      if (frame.type === 'state_snapshot') setProjection(frame.projection)
      if (frame.type === 'chat_history') setEvents(current => dedupe([...frame.events, ...current]))
      if (frame.type === 'chat_event') {
        setEvents(current => dedupe([...current, frame.event]))
        if (frame.event.type.endsWith('_delta')) setProjection(current => foldStream(current, frame.event))
        if (['assistant_message', 'reasoning_completed', 'turn_completed', 'turn_failed', 'turn_interrupted'].includes(frame.event.type)) setProjection(current => current ? { ...current, stream: undefined } : current)
      }
      if (frame.type === 'subagent_events') setSubagents(current => ({ ...current, [frame.agent_id]: frame.events }))
      if (frame.type === 'approval_request') setApprovals(current => [...current.filter(item => item.request_id !== frame.request_id), frame])
      if (frame.type === 'operation_result') {
        setApprovals(current => current.filter(item => item.request_id !== frame.request_id))
        if (frame.request_id.startsWith('question-response:')) {
          const requestID = frame.request_id.slice('question-response:'.length)
          setQuestionResults(current => ({ ...current, [requestID]: { error: frame.ok ? undefined : frame.error || 'The provider did not accept this answer.', version: (current[requestID]?.version ?? 0) + 1 } }))
        }
      }
      if (frame.type === 'host_error') setError(frame.message)
    }
    const listener = (message: MessageEvent<any>) => {
      const data = message.data
      if (data.type === 'state') setState(data)
      if (data.type === 'clearConversation') { setEvents([]); setProjection(undefined); setSubagents({}); setApprovals([]); setQuestionResults({}); setError('') }
      if (data.type === 'history') setHistory(data.entries)
      if (data.type === 'hostExit') setError(data.message)
      if (data.type === 'hostFrame') consume(data.frame as HostFrame)
      if (data.type === 'hostFrames') for (const frame of data.frames as HostFrame[]) consume(frame)
    }
    window.addEventListener('message', listener)
    vscode.postMessage({ type: 'ready' })
    return () => window.removeEventListener('message', listener)
  }, [])

  useEffect(() => { vscode.setState({ draft }) }, [draft])
  useEffect(() => { conversationEnd.current?.scrollIntoView({ block: 'end' }) }, [events, projection?.stream?.text, approvals.length])
  const send = () => { const text = draft.trim(); if (!text) return; vscode.postMessage({ type: 'sendMessage', text }); setDraft('') }

  return <main>
    <header className="profileBar">
      <button className="profile" onClick={() => vscode.postMessage({ type: 'cycleProfile' })} title="Cycle profile (Shift+Tab)">{state.profileLabels?.[state.profile] || state.profile || 'Profile'}</button>
    </header>
    {state.networkMode === 'advisory' && <div className="warning">Network restrictions are advisory on this host and can be bypassed by child processes.</div>}
    {state.networkMode === 'unrestricted' && <div className="warning">This profile allows unrestricted network access.</div>}
    {error && <div className="error">{error}</div>}
    {state.page === 'history' ? <History entries={history} labels={state.profileLabels ?? {}} /> : state.page === 'profiles' ? <Profiles state={state} /> : <>
      <section className="conversation">
        {!events.length && !projection?.stream && <div className="empty"><h2>What are we working on?</h2><p>Claude and Codex run inside the active Hydra profile.</p></div>}
        <Conversation events={events} projection={projection} subagents={subagents} questionResults={questionResults} />
        {approvals.map(approval => <ApprovalCard key={approval.request_id} approval={approval} />)}<div ref={conversationEnd} />
      </section>
      <footer>
        <textarea value={draft} rows={3} placeholder="Ask Hydra..." aria-label="Chat message" onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Tab' && event.shiftKey) { event.preventDefault(); vscode.postMessage({ type: 'cycleProfile' }) }; if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); send() } }} />
        <div className="composerBar"><span>{state.pendingProfile ? `${state.profileLabels?.[state.profile] ?? state.profile} -> ${state.profileLabels?.[state.pendingProfile] ?? state.pendingProfile} after turn` : state.profileLabels?.[state.profile] ?? state.profile}</span>{state.running ? <button onClick={() => vscode.postMessage({ type: 'interrupt' })}>Stop</button> : <button onClick={send}>Send</button>}</div>
      </footer>
    </>}
  </main>
}

function Conversation({ events, projection, subagents, questionResults = {} }: { events: Event[]; projection?: Projection; subagents: Record<string, Event[]>; questionResults?: Record<string, { error?: string; version: number }> }) {
  const items = useMemo(() => conversationItems(events), [events])
  return <>{items.map(item => {
    if (item.kind === 'message') return <article key={item.key} className={`message ${item.role}`}><Markdown text={item.text} /></article>
    if (item.kind === 'step') return <Step key={item.key} item={item} />
    if (item.kind === 'subagent') return <Subagent key={item.key} item={item} events={subagents[item.id]} />
    if (item.kind === 'question') return <QuestionCard key={item.key} item={item} result={questionResults[item.requestID]} />
    return <div key={item.key} className="notice">{item.text}</div>
  })}{projection?.stream?.text && <article className={`message assistant streaming ${projection.stream.kind}`}><Markdown text={projection.stream.text} /><span className="cursor" /></article>}</>
}

function Step({ item }: { item: Extract<Item, { kind: 'step' }> }) { return <details className={`step${item.error ? ' failed' : ''}`}><summary><span>{item.title}</span><small>{item.status}</small></summary><div className="stepBody">{item.input !== undefined && <><label>Input</label><pre>{formatValue(item.input)}</pre></>}{item.output !== undefined && <><label>Output</label><pre>{formatValue(item.output)}</pre></>}</div></details> }

function Subagent({ item, events }: { item: Extract<Item, { kind: 'subagent' }>; events?: Event[] }) {
  const [requested, setRequested] = useState(false)
  return <details className="step subagent" onToggle={event => { if (event.currentTarget.open && !requested) { setRequested(true); vscode.postMessage({ type: 'loadSubagent', agentID: item.id }) } }}><summary><span>{item.title}</span><small>{item.status}</small></summary><div className="stepBody">{item.prompt && <p>{item.prompt}</p>}{events ? <Conversation events={events} subagents={{}} /> : <p className="muted">{requested ? 'Loading transcript...' : 'Expand to load transcript'}</p>}</div></details>
}

function Markdown({ text }: { text: string }) { const html = useMemo(() => DOMPurify.sanitize(marked.parse(text, { async: false }) as string, { USE_PROFILES: { html: true } }), [text]); return <div className="markdown" onClick={event => { const anchor = (event.target as HTMLElement).closest('a'); if (anchor) { event.preventDefault(); vscode.postMessage({ type: 'openLink', href: anchor.href }) } }} dangerouslySetInnerHTML={{ __html: html }} /> }

function ApprovalCard({ approval }: { approval: Approval }) { const answer = (decision: 'allow' | 'deny', scope: 'once' | 'chat' | 'workspace' | 'profile') => vscode.postMessage({ type: 'approval', requestID: approval.request_id, decision, scope }); return <article className="approval"><strong>{approval.summary}</strong><p>{approval.reason}</p><code>{approval.canonical_target ?? approval.target}</code><div className="approvalActions"><button onClick={() => answer('allow', 'once')}>Allow once</button><button onClick={() => answer('allow', 'chat')}>Chat</button><button onClick={() => answer('allow', 'workspace')}>Workspace</button><button onClick={() => answer('allow', 'profile')}>Profile</button><button onClick={() => answer('deny', 'once')}>Deny</button></div></article> }

function QuestionCard({ item, result }: { item: Extract<Item, { kind: 'question' }>; result?: { error?: string; version: number } }) {
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
    vscode.postMessage({ type: 'controlResponse', operationRequestID: `question-response:${item.requestID}`, response })
    setSubmitted(true)
  }
  const heading = item.expired ? 'Question expired' : !item.active ? 'Question answered' : submitted ? 'Submitting answers...' : 'Input needed'
  return <article className={`questionCard${item.active ? '' : ' resolved'}`}><strong>{heading}</strong>{item.answer ? <pre className="answerSummary">{item.answer}</pre> : item.questions.map((question, index) => <fieldset key={question.question} disabled={!active}><legend>{question.header && <small>{question.header}</small>}{question.question}</legend>{question.options.map(option => <label className="questionOption" key={option.label}><input type={question.multiSelect ? 'checkbox' : 'radio'} name={`${item.requestID}-${index}`} checked={(answers[question.question] ?? []).includes(option.label)} onChange={() => toggle(question, option.label)} /><span><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</span></label>)}<label className="otherAnswer"><span>{question.options.length ? 'Other' : 'Answer'}</span><input value={other[question.question] ?? ''} onChange={event => { const value = event.target.value; setOther(current => ({ ...current, [question.question]: value })); if (value && !question.multiSelect) setAnswers(current => ({ ...current, [question.question]: [] })) }} /></label><label className="otherAnswer"><span>Note (optional)</span><textarea rows={2} value={notes[question.question] ?? ''} onChange={event => setNotes(current => ({ ...current, [question.question]: event.target.value }))} /></label></fieldset>)}{result?.error && !submitted && <p className="questionError">{result.error}</p>}{active && <button disabled={!complete} onClick={submit}>Submit answers</button>}</article>
}

function History({ entries, labels }: { entries: any[]; labels: Record<string, string> }) { return <section className="page"><h2>Chat history</h2>{entries.length ? entries.map(entry => <div className="historyRow" key={entry.id}><button onClick={() => vscode.postMessage({ type: 'openHistory', id: entry.id })}><strong>{entry.title}</strong><span>{entry.provider} / {labels[entry.profile] ?? entry.profile} / {relativeTime(entry.updatedAt)}</span></button><button className="delete" aria-label={`Delete ${entry.title}`} onClick={() => vscode.postMessage({ type: 'deleteHistory', id: entry.id })}>Delete</button></div>) : <p>No historical chats yet.</p>}</section> }
function Profiles({ state }: { state: State }) {
  const [selected, setSelected] = useState(state.profile)
  const [scope, setScope] = useState<'user' | 'workspace'>('user')
  const source = state.profileValues?.[selected] ?? {}
  const [draft, setDraft] = useState<any>(() => structuredClone(source))
  useEffect(() => { setDraft(structuredClone(state.profileValues?.[selected] ?? {})) }, [selected, state.profileValues])
  useEffect(() => { if (!state.profiles.includes(selected)) setSelected(state.profile) }, [selected, state.profile, state.profiles])
  const set = (path: string[], value: unknown) => setDraft((current: any) => { const next = structuredClone(current); let target = next; for (const key of path.slice(0, -1)) target = target[key] ??= {}; target[path.at(-1)!] = value; return next })
  const decisions = ['allow', 'ask', 'deny']
  const core = ['read', 'search', 'edit', 'bash', 'fetch']
  const git = ['checkout', 'add', 'commit', 'reset', 'revert', 'cherry_pick', 'merge', 'rebase', 'stash']
  return <section className="page profilesPage"><div className="pageTitle"><h2>Profiles</h2><div><button onClick={() => vscode.postMessage({ type: 'createProfile' })}>New</button><button onClick={() => vscode.postMessage({ type: 'openSettings' })}>Raw settings</button></div></div>
    <select value={selected} onChange={event => setSelected(event.target.value)}>{state.profiles.map(id => <option key={id} value={id}>{state.profileLabels?.[id] ?? id}</option>)}</select>
    <label>Name<input value={draft.name ?? ''} placeholder={selected} onChange={event => set(['name'], event.target.value)} /></label>
    <label>Provider<select value={draft.provider ?? 'codex'} onChange={event => set(['provider'], event.target.value)}><option value="codex">Codex</option><option value="claude">Claude</option></select></label>
    <label>Model<input value={draft.model ?? ''} placeholder="Provider default" onChange={event => set(['model'], event.target.value || undefined)} /></label>
    <label>Standing prompt<textarea rows={4} value={draft.prompt ?? ''} onChange={event => set(['prompt'], event.target.value)} /></label>
    <details open className="settingsGroup"><summary>Core tools</summary><div className="tree">{core.map(tool => <DecisionRow key={tool} label={tool[0].toUpperCase() + tool.slice(1)} value={draft.tools?.core?.[tool] ?? 'deny'} values={decisions} onChange={value => set(['tools', 'core', tool], value)} />)}</div></details>
    <details className="settingsGroup"><summary>Filesystem</summary><div className="tree">{['readable', 'writable', 'copy_on_write', 'masked'].map(key => <ListField key={key} label={key.replace('_', ' ')} values={draft.filesystem?.[key]} onChange={value => set(['filesystem', key], value)} />)}</div></details>
    <details className="settingsGroup"><summary>Network</summary><div className="tree"><DecisionRow label="Mode" value={draft.network?.mode ?? 'hard'} values={['hard', 'advisory', 'off', 'unrestricted']} onChange={value => set(['network', 'mode'], value)} /><ListField label="Allowed hosts" values={draft.network?.allowed_hosts} onChange={value => set(['network', 'allowed_hosts'], value)} /><ListField label="Blocked hosts" values={draft.network?.blocked_hosts} onChange={value => set(['network', 'blocked_hosts'], value)} /></div></details>
    <details className="settingsGroup"><summary>Git</summary><div className="tree"><ListField label="Protected branches" values={draft.git?.protected_branches} onChange={value => set(['git', 'protected_branches'], value)} />{git.map(operation => <DecisionRow key={operation} label={operation.replace('_', ' ')} value={draft.git?.operations?.[operation] ?? 'deny'} values={decisions} onChange={value => set(['git', 'operations', operation], value)} />)}</div></details>
    <details className="settingsGroup"><summary>MCP servers</summary><div className="tree">{Object.entries(draft.tools?.mcp ?? {}).length ? Object.entries(draft.tools.mcp).map(([server, config]: [string, any]) => <details key={server}><summary>{server}</summary><DecisionRow label="Entire server" value={config.decision ?? 'deny'} values={decisions} onChange={value => set(['tools', 'mcp', server, 'decision'], value)} />{Object.entries(config.tools ?? {}).map(([tool, policy]: [string, any]) => <DecisionRow key={tool} label={tool} value={policy.decision} values={decisions} onChange={value => set(['tools', 'mcp', server, 'tools', tool, 'decision'], value)} />)}</details>) : <p className="muted">Add MCP definitions in raw settings; configured servers and tools appear here as an expandable tree.</p>}</div></details>
    <div className="saveRow"><select aria-label="Profile storage" value={scope} onChange={event => setScope(event.target.value as 'user' | 'workspace')}><option value="user">User settings</option><option value="workspace">Workspace settings</option></select><button className="removeProfile" onClick={() => vscode.postMessage({ type: 'deleteProfile', name: selected, scope })}>Remove</button><button className="saveProfile" onClick={() => vscode.postMessage({ type: 'saveProfile', name: selected, profile: draft, scope })}>Save profile</button></div>
  </section>
}

function DecisionRow({ label, value, values, onChange }: { label: string; value: string; values: string[]; onChange: (value: string) => void }) { return <label className="decisionRow"><span>{label}</span><select value={value} onChange={event => onChange(event.target.value)}>{values.map(option => <option key={option}>{option}</option>)}</select></label> }
function ListField({ label, values, onChange }: { label: string; values?: string[]; onChange: (value: string[]) => void }) { return <label>{label}<textarea rows={Math.max(2, Math.min(5, values?.length ?? 2))} value={(values ?? []).join('\n')} onChange={event => onChange(event.target.value.split('\n').map(value => value.trim()).filter(Boolean))} /></label> }

function relativeTime(value: string): string { const seconds = Math.round((Date.now() - new Date(value).getTime()) / 1000); if (seconds < 60) return 'just now'; if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`; if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`; return new Date(value).toLocaleDateString() }

createRoot(document.getElementById('root')!).render(<App />)
