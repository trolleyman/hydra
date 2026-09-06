import DOMPurify from 'dompurify'
import { marked } from 'marked'
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { components } from '../generated/protocol'
import './style.css'

const vscode = acquireVsCodeApi()
type State = { page: 'chat' | 'history' | 'profiles'; profile: string; pendingProfile?: string; profiles: string[]; profileLabels?: Record<string, string>; profileValues?: Record<string, any>; running: boolean; hasConversation: boolean }
type HostFrame = components['schemas']['HostFrame']
type Event = components['schemas']['ChatEvent']
type Projection = components['schemas']['ChatProjection']
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
      if (frame.type === 'operation_result') setApprovals(current => current.filter(item => item.request_id !== frame.request_id))
      if (frame.type === 'host_error') setError(frame.message)
    }
    const listener = (message: MessageEvent<any>) => {
      const data = message.data
      if (data.type === 'state') setState(data)
      if (data.type === 'clearConversation') { setEvents([]); setProjection(undefined); setSubagents({}); setApprovals([]); setError('') }
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
    {error && <div className="error">{error}</div>}
    {state.page === 'history' ? <History entries={history} labels={state.profileLabels ?? {}} /> : state.page === 'profiles' ? <Profiles state={state} /> : <>
      <section className="conversation">
        {!events.length && !projection?.stream && <div className="empty"><h2>What are we working on?</h2><p>Claude and Codex run inside the active Hydra profile.</p></div>}
        <Conversation events={events} projection={projection} subagents={subagents} />
        {approvals.map(approval => <ApprovalCard key={approval.request_id} approval={approval} />)}<div ref={conversationEnd} />
      </section>
      <footer>
        <textarea value={draft} rows={3} placeholder="Ask Hydra..." aria-label="Chat message" onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Tab' && event.shiftKey) { event.preventDefault(); vscode.postMessage({ type: 'cycleProfile' }) }; if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); send() } }} />
        <div className="composerBar"><span>{state.pendingProfile ? `${state.profileLabels?.[state.profile] ?? state.profile} -> ${state.profileLabels?.[state.pendingProfile] ?? state.pendingProfile} after turn` : state.profileLabels?.[state.profile] ?? state.profile}</span>{state.running ? <button onClick={() => vscode.postMessage({ type: 'interrupt' })}>Stop</button> : <button onClick={send}>Send</button>}</div>
      </footer>
    </>}
  </main>
}

function Conversation({ events, projection, subagents }: { events: Event[]; projection?: Projection; subagents: Record<string, Event[]> }) {
  const items = useMemo(() => conversationItems(events), [events])
  return <>{items.map(item => {
    if (item.kind === 'message') return <article key={item.key} className={`message ${item.role}`}><Markdown text={item.text} /></article>
    if (item.kind === 'step') return <Step key={item.key} item={item} />
    if (item.kind === 'subagent') return <Subagent key={item.key} item={item} events={subagents[item.id]} />
    if (item.kind === 'question') return <QuestionCard key={item.key} item={item} />
    return <div key={item.key} className="notice">{item.text}</div>
  })}{projection?.stream?.text && <article className={`message assistant streaming ${projection.stream.kind}`}><Markdown text={projection.stream.text} /><span className="cursor" /></article>}</>
}

type QuestionSpec = { question: string; header?: string; multiSelect: boolean; options: { label: string; description?: string }[] }
type Item =
  | { kind: 'message'; key: string; role: 'user' | 'assistant'; text: string }
  | { kind: 'step'; key: string; title: string; input?: unknown; output?: unknown; status?: string; error?: boolean }
  | { kind: 'subagent'; key: string; id: string; title: string; status: string; prompt?: string }
  | { kind: 'question'; key: string; requestID: string; questions: QuestionSpec[]; active: boolean }
  | { kind: 'notice'; key: string; text: string }

function conversationItems(events: Event[]): Item[] {
  const items: Item[] = [], tools = new Map<string, number>(), agents = new Map<string, number>(), questions = new Map<string, number>()
  for (const event of events) {
    const payload = (event.payload ?? {}) as Record<string, any>
    if (payload.sidechain === true || event.type.endsWith('_delta') || event.type === 'usage_updated') continue
    if (event.type === 'user_message') items.push({ kind: 'message', key: `e${event.seq}`, role: 'user', text: textFrom(payload) })
    else if (event.type === 'assistant_message') items.push({ kind: 'message', key: `e${event.seq}`, role: 'assistant', text: String(payload.text ?? '') })
    else if (event.type === 'reasoning_completed') items.push({ kind: 'step', key: `e${event.seq}`, title: 'Reasoning', output: payload.text ?? payload.content, status: duration(payload.duration_ms) })
    else if (event.type === 'tool_started' && payload.name !== 'AskUserQuestion') { const id = String(payload.id ?? event.seq); tools.set(id, items.length); items.push({ kind: 'step', key: `tool-${id}`, title: toolTitle(payload), input: payload.input, status: 'Running' }) }
    else if (event.type === 'tool_completed' && payload.name !== 'AskUserQuestion') { const id = String(payload.id ?? event.seq), prior = tools.get(id); const item: Item = { kind: 'step', key: `tool-${id}`, title: toolTitle(payload), input: payload.input, output: payload.output, status: payload.status ?? (payload.is_error ? 'Failed' : 'Completed'), error: Boolean(payload.is_error) }; if (prior === undefined) { tools.set(id, items.length); items.push(item) } else items[prior] = item }
    else if (event.type.startsWith('subagent_')) { const id = String(payload.id ?? payload.agent_id ?? event.seq), prior = agents.get(id); const item: Item = { kind: 'subagent', key: `agent-${id}`, id, title: payload.description ?? `Sub-agent ${id}`, status: payload.status ?? event.type.replace('subagent_', ''), prompt: payload.prompt }; if (prior === undefined) { agents.set(id, items.length); items.push(item) } else items[prior] = item }
    else if (event.type === 'interaction_requested') {
      const parsed = parseInteraction(payload)
      if (parsed) {
        questions.set(parsed.requestID, items.length)
        items.push({ kind: 'question', key: `question-${parsed.requestID}`, ...parsed, active: true })
      }
    } else if (event.type === 'interaction_resolved') {
      const requestID = String(payload.request_id ?? '')
      const prior = requestID ? questions.get(requestID) : [...questions.values()].at(-1)
      if (prior !== undefined && items[prior]?.kind === 'question') items[prior] = { ...items[prior], active: false }
    } else if (['turn_completed', 'turn_failed', 'turn_interrupted'].includes(event.type)) {
      for (const prior of questions.values()) if (items[prior]?.kind === 'question') items[prior] = { ...items[prior], active: false }
    }
    else if (event.type === 'notice' || event.type === 'commit_created') items.push({ kind: 'notice', key: `e${event.seq}`, text: String(payload.text ?? payload.summary ?? 'Git commit created') })
  }
  return items
}

function Step({ item }: { item: Extract<Item, { kind: 'step' }> }) { return <details className={`step${item.error ? ' failed' : ''}`}><summary><span>{item.title}</span><small>{item.status}</small></summary><div className="stepBody">{item.input !== undefined && <><label>Input</label><pre>{formatValue(item.input)}</pre></>}{item.output !== undefined && <><label>Output</label><pre>{formatValue(item.output)}</pre></>}</div></details> }

function Subagent({ item, events }: { item: Extract<Item, { kind: 'subagent' }>; events?: Event[] }) {
  const [requested, setRequested] = useState(false)
  return <details className="step subagent" onToggle={event => { if (event.currentTarget.open && !requested) { setRequested(true); vscode.postMessage({ type: 'loadSubagent', agentID: item.id }) } }}><summary><span>{item.title}</span><small>{item.status}</small></summary><div className="stepBody">{item.prompt && <p>{item.prompt}</p>}{events ? <Conversation events={events} subagents={{}} /> : <p className="muted">{requested ? 'Loading transcript...' : 'Expand to load transcript'}</p>}</div></details>
}

function Markdown({ text }: { text: string }) { const html = useMemo(() => DOMPurify.sanitize(marked.parse(text, { async: false }) as string, { USE_PROFILES: { html: true } }), [text]); return <div className="markdown" onClick={event => { const anchor = (event.target as HTMLElement).closest('a'); if (anchor) { event.preventDefault(); vscode.postMessage({ type: 'openLink', href: anchor.href }) } }} dangerouslySetInnerHTML={{ __html: html }} /> }

function ApprovalCard({ approval }: { approval: Approval }) { const answer = (decision: 'allow' | 'deny', scope: 'once' | 'chat' | 'workspace' | 'profile') => vscode.postMessage({ type: 'approval', requestID: approval.request_id, decision, scope }); return <article className="approval"><strong>{approval.summary}</strong><p>{approval.reason}</p><code>{approval.canonical_target ?? approval.target}</code><div className="approvalActions"><button onClick={() => answer('allow', 'once')}>Allow once</button><button onClick={() => answer('allow', 'chat')}>Chat</button><button onClick={() => answer('allow', 'workspace')}>Workspace</button><button onClick={() => answer('allow', 'profile')}>Profile</button><button onClick={() => answer('deny', 'once')}>Deny</button></div></article> }

function QuestionCard({ item }: { item: Extract<Item, { kind: 'question' }> }) {
  const [answers, setAnswers] = useState<Record<string, string[]>>({})
  const [other, setOther] = useState<Record<string, string>>({})
  const [submitted, setSubmitted] = useState(false)
  const active = item.active && !submitted
  const toggle = (question: QuestionSpec, label: string) => setAnswers(current => {
    const selected = current[question.question] ?? []
    const next = question.multiSelect ? selected.includes(label) ? selected.filter(value => value !== label) : [...selected, label] : [label]
    return { ...current, [question.question]: next }
  })
  const submit = () => {
    const values = Object.fromEntries(item.questions.map(question => [question.question, [...(answers[question.question] ?? []), ...(other[question.question]?.trim() ? [other[question.question].trim()] : [])].join(', ')]))
    if (Object.values(values).some(value => !value)) return
    vscode.postMessage({ type: 'controlResponse', response: { subtype: 'success', request_id: item.requestID, response: { behavior: 'allow', updatedInput: { answers: values } } } })
    setSubmitted(true)
  }
  return <article className={`questionCard${active ? '' : ' resolved'}`}><strong>{active ? 'Input needed' : 'Question answered'}</strong>{item.questions.map(question => <fieldset key={question.question} disabled={!active}><legend>{question.header && <small>{question.header}</small>}{question.question}</legend>{question.options.map(option => <label className="questionOption" key={option.label}><input type={question.multiSelect ? 'checkbox' : 'radio'} name={question.question} checked={(answers[question.question] ?? []).includes(option.label)} onChange={() => toggle(question, option.label)} /><span><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</span></label>)}<label className="otherAnswer"><span>{question.options.length ? 'Other' : 'Answer'}</span><input value={other[question.question] ?? ''} onChange={event => setOther(current => ({ ...current, [question.question]: event.target.value }))} /></label></fieldset>)}{active && <button onClick={submit}>Submit answers</button>}</article>
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
  return <section className="page profilesPage"><div className="pageTitle"><h2>Profiles</h2><button onClick={() => vscode.postMessage({ type: 'openSettings' })}>Raw settings</button></div>
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
    <div className="saveRow"><select aria-label="Profile storage" value={scope} onChange={event => setScope(event.target.value as 'user' | 'workspace')}><option value="user">User settings</option><option value="workspace">Workspace settings</option></select><button className="saveProfile" onClick={() => vscode.postMessage({ type: 'saveProfile', name: selected, profile: draft, scope })}>Save profile</button></div>
  </section>
}

function DecisionRow({ label, value, values, onChange }: { label: string; value: string; values: string[]; onChange: (value: string) => void }) { return <label className="decisionRow"><span>{label}</span><select value={value} onChange={event => onChange(event.target.value)}>{values.map(option => <option key={option}>{option}</option>)}</select></label> }
function ListField({ label, values, onChange }: { label: string; values?: string[]; onChange: (value: string[]) => void }) { return <label>{label}<textarea rows={Math.max(2, Math.min(5, values?.length ?? 2))} value={(values ?? []).join('\n')} onChange={event => onChange(event.target.value.split('\n').map(value => value.trim()).filter(Boolean))} /></label> }

function parseInteraction(payload: Record<string, any>): { requestID: string; questions: QuestionSpec[] } | undefined {
  const interaction = payload.interaction && typeof payload.interaction === 'object' ? payload.interaction as Record<string, any> : {}
  const codex = interaction.method === 'item/tool/requestUserInput'
  const requestID = String(codex ? interaction.request_id ?? '' : payload.request_id ?? '')
  const rawInput = codex ? interaction.params : interaction.input
  const input = typeof rawInput === 'string' ? parseJSON(rawInput) : rawInput
  if (!requestID || !input || !Array.isArray(input.questions)) return undefined
  const questions = input.questions.flatMap((raw: unknown) => {
    if (!raw || typeof raw !== 'object' || typeof (raw as any).question !== 'string') return []
    const value = raw as Record<string, any>
    const options = Array.isArray(value.options) ? value.options.flatMap((option: unknown) => option && typeof option === 'object' && typeof (option as any).label === 'string' ? [{ label: (option as any).label, description: typeof (option as any).description === 'string' ? (option as any).description : undefined }] : []) : []
    return [{ question: value.question, header: typeof value.header === 'string' ? value.header : undefined, multiSelect: value.multiSelect === true, options }]
  })
  return questions.length ? { requestID, questions } : undefined
}

function parseJSON(value: string): any { try { return JSON.parse(value) } catch { return undefined } }

function foldStream(current: Projection | undefined, event: Event): Projection { const payload = (event.payload ?? {}) as Record<string, any>, kind = event.type === 'reasoning_delta' ? 'thinking' : 'text', previous = current?.stream, same = previous?.kind === kind && previous?.message_id === payload.message_id; return { ...current, version: current?.version ?? 1, through: event.seq, stream: { kind, message_id: payload.message_id, text: (same ? previous?.text ?? '' : '') + String(payload.text ?? '') } } }
function textFrom(payload: Record<string, any>): string { return typeof payload.text === 'string' ? payload.text : Array.isArray(payload.content) ? payload.content.map(item => item?.text ?? '').join('') : '' }
function toolTitle(payload: Record<string, any>): string { const input = payload.input as Record<string, any> | undefined; return String(input?.description || payload.name || 'Tool') }
function formatValue(value: unknown): string { if (typeof value === 'string') { try { return JSON.stringify(JSON.parse(value), null, 2) } catch { return value } } return JSON.stringify(value, null, 2) }
function duration(milliseconds: unknown): string | undefined { return typeof milliseconds === 'number' ? milliseconds < 1000 ? `${milliseconds} ms` : `${(milliseconds / 1000).toFixed(1)} s` : undefined }
function relativeTime(value: string): string { const seconds = Math.round((Date.now() - new Date(value).getTime()) / 1000); if (seconds < 60) return 'just now'; if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`; if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`; return new Date(value).toLocaleDateString() }
function dedupe(events: Event[]): Event[] { return [...new Map(events.map(event => [event.seq, event])).values()].sort((a, b) => a.seq - b.seq) }

createRoot(document.getElementById('root')!).render(<App />)
