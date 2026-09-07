import type { components } from '../generated/protocol'

export type Event = components['schemas']['ChatEvent']
export type Projection = components['schemas']['ChatProjection']
export type QuestionSpec = { question: string; header?: string; multiSelect: boolean; options: { label: string; description?: string }[] }
export type Item =
  | { kind: 'message'; key: string; role: 'user' | 'assistant'; text: string }
  | { kind: 'step'; key: string; title: string; summary?: string; input?: unknown; output?: unknown; status?: string; error?: boolean }
  | { kind: 'subagent'; key: string; id: string; title: string; status: string; prompt?: string }
  | { kind: 'question'; key: string; requestID: string; toolID?: string; questions: QuestionSpec[]; active: boolean; expired?: boolean; answer?: string }
  | { kind: 'commit'; key: string; sha: string; subject: string; additions?: number; deletions?: number }
  | { kind: 'notice'; key: string; text: string }

export function conversationItems(events: Event[]): Item[] {
  const items: Item[] = []
  const tools = new Map<string, number>()
  const agents = new Map<string, number>()
  const questions = new Map<string, number>()
  const questionTools = new Map<string, number>()
  for (const event of events) {
    const payload = (event.payload ?? {}) as Record<string, any>
    if (payload.sidechain === true || event.type.endsWith('_delta') || event.type === 'usage_updated') continue
    if (event.type === 'user_message') items.push({ kind: 'message', key: `e${event.seq}`, role: 'user', text: textFrom(payload) })
    else if (event.type === 'assistant_message') items.push({ kind: 'message', key: `e${event.seq}`, role: 'assistant', text: String(payload.text ?? '') })
    else if (event.type === 'reasoning_completed') items.push({ kind: 'step', key: `e${event.seq}`, title: 'Reasoning', output: payload.text ?? payload.content, status: duration(payload.duration_ms) })
    else if (event.type === 'tool_started' && payload.name !== 'AskUserQuestion') {
      const id = String(payload.id ?? event.seq)
      tools.set(id, items.length)
      items.push({ kind: 'step', key: `tool-${id}`, title: String(payload.name || 'Tool'), summary: toolSummary(payload), input: payload.input, status: 'Running' })
    } else if (event.type === 'tool_completed' && payload.name === 'AskUserQuestion') {
      const prior = questionTools.get(String(payload.id ?? ''))
      if (prior !== undefined && items[prior]?.kind === 'question') items[prior] = { ...items[prior], active: false, answer: outputText(payload.output ?? payload.content) }
    } else if (event.type === 'tool_completed') {
      const id = String(payload.id ?? event.seq)
      const prior = tools.get(id)
      const started = prior === undefined ? undefined : items[prior]?.kind === 'step' ? items[prior] : undefined
      const item: Item = { kind: 'step', key: `tool-${id}`, title: String(payload.name || started?.title || 'Tool'), summary: toolSummary(payload) || started?.summary, input: payload.input ?? started?.input, output: payload.output, status: payload.is_error ? 'Failed' : undefined, error: Boolean(payload.is_error) }
      if (prior === undefined) {
        tools.set(id, items.length)
        items.push(item)
      } else items[prior] = item
    } else if (event.type.startsWith('subagent_')) {
      const id = String(payload.id ?? payload.agent_id ?? event.seq)
      const prior = agents.get(id)
      const item: Item = { kind: 'subagent', key: `agent-${id}`, id, title: payload.description ?? `Sub-agent ${id}`, status: payload.status ?? event.type.replace('subagent_', ''), prompt: payload.prompt }
      if (prior === undefined) {
        agents.set(id, items.length)
        items.push(item)
      } else items[prior] = item
    } else if (event.type === 'interaction_requested') {
      const parsed = parseInteraction(payload)
      if (parsed) {
        questions.set(parsed.requestID, items.length)
        if (parsed.toolID) questionTools.set(parsed.toolID, items.length)
        items.push({ kind: 'question', key: `question-${parsed.requestID}`, ...parsed, active: true })
      }
    } else if (event.type === 'interaction_resolved') {
      const requestID = String(payload.request_id ?? '')
      const prior = requestID ? questions.get(requestID) : [...questions.values()].at(-1)
      if (prior !== undefined && items[prior]?.kind === 'question') items[prior] = { ...items[prior], active: false, answer: resolvedAnswer(payload) }
    } else if (['turn_completed', 'turn_failed', 'turn_interrupted'].includes(event.type)) {
      for (const prior of questions.values()) if (items[prior]?.kind === 'question' && items[prior].active) items[prior] = { ...items[prior], active: false, expired: true }
    } else if (event.type === 'commit_created') {
      items.push({ kind: 'commit', key: `e${event.seq}`, sha: String(payload.short_sha ?? payload.sha ?? '').slice(0, 8), subject: String(payload.subject ?? 'Git commit created'), additions: numberValue(payload.additions), deletions: numberValue(payload.deletions) })
    } else if (event.type === 'notice') {
      items.push({ kind: 'notice', key: `e${event.seq}`, text: String(payload.text ?? payload.summary ?? 'Notice') })
    }
  }
  return items
}

export function foldStream(current: Projection | undefined, event: Event): Projection {
  const payload = (event.payload ?? {}) as Record<string, any>
  const kind = event.type === 'reasoning_delta' ? 'thinking' : 'text'
  const previous = current?.stream
  const same = previous?.kind === kind && previous?.message_id === payload.message_id
  return { ...current, version: current?.version ?? 1, through: event.seq, stream: { kind, message_id: payload.message_id, text: (same ? previous?.text ?? '' : '') + String(payload.text ?? '') } }
}

export function parseInteraction(payload: Record<string, any>): { requestID: string; toolID?: string; questions: QuestionSpec[] } | undefined {
  const interaction = payload.interaction && typeof payload.interaction === 'object' ? payload.interaction as Record<string, any> : {}
  const codex = interaction.method === 'item/tool/requestUserInput'
  const requestID = String(codex ? interaction.request_id ?? '' : payload.request_id ?? '')
  const rawInput = codex ? interaction.params : interaction.input
  const input = typeof rawInput === 'string' ? parseJSON(rawInput) : rawInput
  if (!requestID || !input || !Array.isArray(input.questions)) return undefined
  const questions = input.questions.flatMap((raw: unknown) => {
    if (!raw || typeof raw !== 'object' || typeof (raw as any).question !== 'string') return []
    const value = raw as Record<string, any>
    const options = Array.isArray(value.options) ? value.options.flatMap((option: unknown) => option && typeof option === 'object' && typeof (option as any).label === 'string' ? [{ label: (option as any).label, ...(typeof (option as any).description === 'string' ? { description: (option as any).description } : {}) }] : []) : []
    return [{ question: value.question, header: typeof value.header === 'string' ? value.header : undefined, multiSelect: value.multiSelect === true, options }]
  })
  const toolID = String(codex ? input.itemId ?? '' : interaction.tool_use_id ?? '')
  return questions.length ? { requestID, ...(toolID ? { toolID } : {}), questions } : undefined
}

export function buildQuestionResponse(requestID: string, questions: QuestionSpec[], answers: Record<string, string[]>, other: Record<string, string>, notes: Record<string, string>): Record<string, unknown> | undefined {
  const values = Object.fromEntries(questions.map(question => [question.question, [...(answers[question.question] ?? []), ...(other[question.question]?.trim() ? [other[question.question].trim()] : [])].join(', ')]))
  if (Object.values(values).some(value => !value)) return undefined
  const annotations = Object.fromEntries(Object.entries(notes).filter(([, note]) => note.trim()).map(([question, note]) => [question, { notes: note.trim() }]))
  const updatedInput = { answers: values, ...(Object.keys(annotations).length ? { annotations } : {}) }
  return { subtype: 'success', request_id: requestID, response: { behavior: 'allow', updatedInput } }
}

export function dedupe(events: Event[]): Event[] {
  return [...new Map(events.map(event => [event.seq, event])).values()].sort((a, b) => a.seq - b.seq)
}

export function formatValue(value: unknown): string {
  if (typeof value === 'string') {
    try { return JSON.stringify(JSON.parse(value), null, 2) } catch { return value }
  }
  return JSON.stringify(value, null, 2)
}

export function splitAttachments(text: string): { text: string; attachments: string[] } {
  const marker = 'Attached files (read these paths):\n'
  const index = text.lastIndexOf(`\n\n${marker}`)
  const start = index >= 0 ? index + 2 : text.startsWith(marker) ? 0 : -1
  if (start < 0) return { text, attachments: [] }
  const attachments = text.slice(start + marker.length).split('\n').flatMap(line => {
    if (!line.startsWith('- ')) return []
    try { const value = JSON.parse(line.slice(2)); return typeof value === 'string' ? [value] : [] } catch { return [] }
  })
  if (!attachments.length) return { text, attachments: [] }
  return { text: text.slice(0, index >= 0 ? index : 0), attachments }
}

function textFrom(payload: Record<string, any>): string { return typeof payload.text === 'string' ? payload.text : Array.isArray(payload.content) ? payload.content.map(item => item?.text ?? '').join('') : '' }
function toolSummary(payload: Record<string, any>): string | undefined {
  const input = payload.input as Record<string, any> | undefined
  if (!input) return undefined
  for (const key of ['description', 'file_path', 'path', 'pattern', 'query', 'url', 'command', 'prompt']) {
    const value = input[key]
    if (typeof value === 'string' && value.trim()) return value.trim().split('\n')[0]
  }
  return undefined
}
function numberValue(value: unknown): number | undefined { return typeof value === 'number' ? value : undefined }
function duration(milliseconds: unknown): string | undefined { return typeof milliseconds === 'number' ? `${Math.max(1, Math.ceil(milliseconds / 1000))}s` : undefined }
function parseJSON(value: string): any { try { return JSON.parse(value) } catch { return undefined } }
function outputText(value: unknown): string { if (typeof value === 'string') return value; if (Array.isArray(value)) return value.map(item => typeof item === 'string' ? item : item && typeof item === 'object' ? String((item as any).text ?? (item as any).content ?? '') : '').filter(Boolean).join('\n'); return value == null ? '' : JSON.stringify(value, null, 2) }
function resolvedAnswer(payload: Record<string, any>): string {
  const interaction = payload.interaction && typeof payload.interaction === 'object' ? payload.interaction : {}
  const updated = interaction.response?.updatedInput ?? interaction.updatedInput ?? {}
  const answers = updated.answers && typeof updated.answers === 'object' ? updated.answers : {}
  return Object.entries(answers).map(([question, answer]) => `${question}: ${String(answer)}`).join('\n')
}
