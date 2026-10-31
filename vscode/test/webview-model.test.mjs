import assert from 'node:assert/strict'
import test from 'node:test'
import { buildQuestionResponse, conversationItems, dedupe, foldStream, parseInteraction, splitAttachments } from '../src/webview/model.ts'

const event = (seq, type, payload = {}) => ({ seq, type, timestamp: '2026-09-07T00:00:00Z', payload })

test('stream folding appends one message and advances the projection cursor', () => {
  const first = foldStream(undefined, event(8, 'assistant_delta', { message_id: 'm1', text: 'Hello' }))
  const second = foldStream(first, event(9, 'assistant_delta', { message_id: 'm1', text: ' world' }))
  assert.equal(second.through, 9)
  assert.equal(second.stream?.text, 'Hello world')
  const reasoning = foldStream(second, event(10, 'reasoning_delta', { message_id: 'r1', text: 'Think' }))
  assert.equal(reasoning.stream?.kind, 'thinking')
  assert.equal(reasoning.stream?.text, 'Think')
})

test('conversation projection pairs tool and sub-agent lifecycle events', () => {
  const items = conversationItems([
    event(1, 'user_message', { content: [{ type: 'text', text: 'Fix it' }] }),
    event(2, 'tool_started', { id: 'tool-1', name: 'Bash', input: { description: 'Run check' } }),
    event(3, 'tool_completed', { id: 'tool-1', name: 'Bash', output: 'ok', status: 'completed' }),
    event(4, 'subagent_started', { id: 'agent-1', description: 'Review', status: 'running' }),
    event(5, 'subagent_completed', { id: 'agent-1', description: 'Review', status: 'completed' }),
  ])
  assert.equal(items.length, 3)
  assert.deepEqual(items[1], { kind: 'step', key: 'tool-tool-1', title: 'Bash', summary: 'Run check', input: { description: 'Run check' }, output: 'ok', status: undefined, error: false })
  assert.equal(items[2].kind, 'subagent')
  assert.equal(items[2].status, 'completed')
})

test('Claude and Codex question requests normalize to the same card shape', () => {
  const questions = [{ question: 'Which?', header: 'Choice', multiSelect: false, options: [{ label: 'A' }] }]
  const claude = parseInteraction({ request_id: 'claude-1', interaction: { input: JSON.stringify({ questions }) } })
  const codex = parseInteraction({ interaction: { method: 'item/tool/requestUserInput', request_id: 42, params: { questions } } })
  assert.deepEqual(claude, { requestID: 'claude-1', questions })
  assert.deepEqual(codex, { requestID: '42', questions })
})

test('a terminal turn makes an unanswered replayed question read-only', () => {
  const items = conversationItems([
    event(1, 'interaction_requested', { request_id: 'q1', interaction: { input: { questions: [{ question: 'Continue?', options: [] }] } } }),
    event(2, 'turn_interrupted', { status: 'interrupted' }),
  ])
  assert.equal(items[0].kind, 'question')
  assert.equal(items[0].active, false)
  assert.equal(items[0].expired, true)
})

test('resolved questions retain a durable read-only answer summary', () => {
  const claude = conversationItems([
    event(1, 'interaction_requested', { request_id: 'q1', interaction: { tool_use_id: 'tool-1', input: { questions: [{ question: 'Which?', options: [{ label: 'A' }] }] } } }),
    event(2, 'tool_completed', { id: 'tool-1', name: 'AskUserQuestion', output: 'User answered: "Which?"="A".' }),
  ])
  assert.equal(claude[0].kind, 'question')
  assert.equal(claude[0].answer, 'User answered: "Which?"="A".')

  const codex = conversationItems([
    event(1, 'interaction_requested', { interaction: { method: 'item/tool/requestUserInput', request_id: 42, params: { questions: [{ id: 'q1', question: 'Which?' }] } } }),
    event(2, 'interaction_resolved', { interaction: { method: 'item/tool/requestUserInput', response: { updatedInput: { answers: { 'Which?': 'A' } } } } }),
  ])
  assert.equal(codex[0].kind, 'question')
  assert.equal(codex[0].answer, 'Which?: A')
})

test('question responses preserve multi-select choices, free text, and notes', () => {
  const questions = [
    { question: 'Which?', multiSelect: true, options: [{ label: 'A' }, { label: 'B' }] },
    { question: 'Why?', multiSelect: false, options: [] },
  ]
  assert.equal(buildQuestionResponse('q1', questions, { 'Which?': ['A', 'B'] }, {}, {}), undefined)
  assert.deepEqual(buildQuestionResponse('q1', questions, { 'Which?': ['A', 'B'] }, { 'Why?': 'Because' }, { 'Which?': 'except in prod' }), {
    subtype: 'success',
    request_id: 'q1',
    response: {
      behavior: 'allow',
      updatedInput: {
        answers: { 'Which?': 'A, B', 'Why?': 'Because' },
        annotations: { 'Which?': { notes: 'except in prod' } },
      },
    },
  })
})

test('history event deduplication is sequence ordered', () => {
  assert.deepEqual(dedupe([event(2, 'notice'), event(1, 'notice'), event(2, 'notice')]).map(value => value.seq), [1, 2])
})

test('attachment references round-trip as presentation metadata', () => {
  assert.deepEqual(splitAttachments('Review this\n\nAttached files (read these paths):\n- "src/a.ts"\n- "/tmp/image.png"'), {
    text: 'Review this',
    attachments: ['src/a.ts', '/tmp/image.png'],
  })
})
