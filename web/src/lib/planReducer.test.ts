import { describe, it, expect } from 'vitest'
import { createPlanBuilder, parseTaskCreate, parseTaskUpdate, parseTodos, toTodoItems, type TodoItem } from './planReducer'
import type { PlanEntry } from './planStore'

// A builder plus the entries from its latest onChange, which is what the panel
// renders and what gets persisted.
function build(seed: PlanEntry[] = []) {
  let latest: PlanEntry[] = seed
  const plan = createPlanBuilder(seed, (e) => {
    latest = e
  })
  return { plan, published: () => latest }
}

// The transcript of one task being created: the tool_use, then the result that
// carries its real "#N" id.
function create(plan: ReturnType<typeof build>['plan'], useId: string, id: number, subject: string) {
  plan.applyTaskTool('TaskCreate', { subject }, useId)
  plan.applyTaskResult(useId, `Task #${id} created successfully: ${subject}`)
}

const entry = (over: Partial<PlanEntry> & { key: string; content: string; order: number }): PlanEntry => ({
  status: 'completed',
  ...over,
})

describe('createPlanBuilder', () => {
  it('builds a plan from TaskCreate + TaskUpdate', () => {
    const { plan, published } = build()
    create(plan, 'u1', 1, 'First task')
    create(plan, 'u2', 2, 'Second task')
    plan.applyTaskTool('TaskUpdate', { taskId: '1', status: 'completed' }, 'u3')
    plan.applyTaskTool('TaskUpdate', { taskId: '2', status: 'in_progress' }, 'u4')

    expect(published()).toEqual([
      { key: '1', content: 'First task', status: 'completed', activeForm: undefined, description: undefined, order: 1 },
      { key: '2', content: 'Second task', status: 'in_progress', activeForm: undefined, description: undefined, order: 2 },
    ])
  })

  it('keys a created task by the real id from its result, not creation order', () => {
    // The replay window dropped the earlier creates, so the ids start at #17
    // while this session's creation order starts at 1. A TaskUpdate names #17.
    const { plan, published } = build()
    create(plan, 'u1', 17, 'Late task')
    plan.applyTaskTool('TaskUpdate', { taskId: '17', status: 'completed' }, 'u2')

    expect(published()).toEqual([
      { key: '17', content: 'Late task', status: 'completed', activeForm: undefined, description: undefined, order: 1 },
    ])
  })

  // The regression: a restored plan replayed its own creates and every task
  // rendered twice - once completed, once as a stuck pending clone - inflating
  // the panel's N/M count (10 tasks read as "10/20").
  it('folds a replayed TaskCreate into the task it restored, without duplicating it', () => {
    const seed = [
      entry({ key: '1', content: 'First task', order: 1 }),
      entry({ key: '2', content: 'Second task', order: 2 }),
      entry({ key: '3', content: 'Third task', order: 3 }),
    ]
    const { plan, published } = build(seed)

    // The replay re-delivers the very creates that produced the seeded entries.
    create(plan, 'u1', 1, 'First task')
    create(plan, 'u2', 2, 'Second task')
    create(plan, 'u3', 3, 'Third task')

    expect(published()).toEqual(seed)
    expect(published().filter((e) => e.key.startsWith('use:'))).toEqual([])
    // Every task once, and all still completed - not reset to the create's
    // `pending`, which is older than the restored status.
    expect(toTodoItems(published()).map((t) => t.content)).toEqual(['First task', 'Second task', 'Third task'])
    expect(published().every((e) => e.status === 'completed')).toBe(true)
  })

  it('lets a replayed TaskUpdate move a restored task on from its seeded status', () => {
    const seed = [entry({ key: '1', content: 'A task', status: 'in_progress', order: 1 })]
    const { plan, published } = build(seed)
    create(plan, 'u1', 1, 'A task')
    plan.applyTaskTool('TaskUpdate', { taskId: '1', status: 'completed' }, 'u2')

    expect(published()).toEqual([{ key: '1', content: 'A task', status: 'completed', activeForm: undefined, description: undefined, order: 1 }])
  })

  it('refreshes a restored task text from the replayed create that renamed it', () => {
    const seed = [entry({ key: '1', content: 'Stale subject', order: 1, description: 'stale' })]
    const { plan, published } = build(seed)
    plan.applyTaskTool('TaskCreate', { subject: 'Fresh subject', description: 'fresh' }, 'u1')
    plan.applyTaskResult('u1', 'Task #1 created successfully: Fresh subject')

    expect(published()).toEqual([
      { key: '1', content: 'Fresh subject', status: 'completed', activeForm: undefined, description: 'fresh', order: 1 },
    ])
  })

  it('keeps a restored task a TaskUpdate names but whose create never replays', () => {
    // The create scrolled out of the window; only the update is left. Without
    // the seed this update would have nothing to land on.
    const seed = [entry({ key: '5', content: 'Older task', status: 'pending', order: 5 })]
    const { plan, published } = build(seed)
    plan.applyTaskTool('TaskUpdate', { taskId: '5', status: 'completed' }, 'u1')

    expect(published()).toEqual([{ key: '5', content: 'Older task', status: 'completed', activeForm: undefined, description: undefined, order: 5 }])
  })

  it('appends a genuinely new task after the restored ones', () => {
    const seed = [entry({ key: '1', content: 'Restored', order: 1 })]
    const { plan, published } = build(seed)
    create(plan, 'u1', 1, 'Restored') // replayed
    create(plan, 'u2', 2, 'Brand new') // actually new

    expect(published().map((e) => [e.key, e.content, e.status])).toEqual([
      ['1', 'Restored', 'completed'],
      ['2', 'Brand new', 'pending'],
    ])
  })

  it('drops a task on a "deleted" TaskUpdate', () => {
    const { plan, published } = build()
    create(plan, 'u1', 1, 'Doomed')
    create(plan, 'u2', 2, 'Survivor')
    plan.applyTaskTool('TaskUpdate', { taskId: '1', status: 'deleted' }, 'u3')

    expect(published().map((e) => e.content)).toEqual(['Survivor'])
  })

  it('ignores a TaskUpdate for an unknown task', () => {
    const { plan, published } = build()
    create(plan, 'u1', 1, 'Only task')
    plan.applyTaskTool('TaskUpdate', { taskId: '99', status: 'completed' }, 'u2')

    expect(published().map((e) => [e.key, e.status])).toEqual([['1', 'pending']])
  })

  it('ignores a result for a tool_use it never saw created', () => {
    const { plan, published } = build()
    plan.applyTaskResult('unknown', 'Task #4 created successfully: Ghost')
    expect(published()).toEqual([])
  })

  it('falls back to creation order when the result carries no id', () => {
    const { plan, published } = build()
    plan.applyTaskTool('TaskCreate', { subject: 'No id in result' }, 'u1')
    plan.applyTaskResult('u1', 'created successfully')
    expect(published().map((e) => e.key)).toEqual(['1'])
  })

  it('ignores tools that are not TaskCreate/TaskUpdate, and malformed inputs', () => {
    const { plan, published } = build()
    plan.applyTaskTool('Bash', { command: 'ls' }, 'u1')
    plan.applyTaskTool('TaskCreate', { notASubject: true }, 'u2')
    plan.applyTaskTool('TaskUpdate', { status: 'completed' }, 'u3')
    expect(published()).toEqual([])
  })

  it('replaces a TodoWrite plan when the session switches to Task*', () => {
    const { plan, published } = build()
    plan.applyTodoWrite([
      { content: 'Todo one', status: 'completed' },
      { content: 'Todo two', status: 'pending' },
    ])
    expect(published().map((e) => e.key)).toEqual(['todo:0', 'todo:1'])

    create(plan, 'u1', 1, 'Task one')
    expect(published().map((e) => [e.key, e.content, e.order])).toEqual([['1', 'Task one', 1]])
  })

  it('replaces the whole list on each TodoWrite', () => {
    const { plan, published } = build()
    plan.applyTodoWrite([{ content: 'One', status: 'pending' }])
    plan.applyTodoWrite([
      { content: 'One', status: 'completed' },
      { content: 'Two', status: 'in_progress' },
    ])
    expect(published().map((e) => [e.content, e.status])).toEqual([
      ['One', 'completed'],
      ['Two', 'in_progress'],
    ])
  })

  it('restores a TodoWrite plan without a Task* create wiping it', () => {
    // planMode is inferred from the seeded keys: a restored todo: plan stays a
    // TodoWrite plan, so a further TodoWrite just replaces it.
    const seed = [entry({ key: 'todo:0', content: 'Restored todo', order: 1 })]
    const { plan, published } = build(seed)
    plan.applyTodoWrite([{ content: 'Restored todo', status: 'completed' }])
    expect(published().map((e) => e.key)).toEqual(['todo:0'])
  })
})

describe('parseTodos', () => {
  it('reads a well-formed list', () => {
    expect(parseTodos({ todos: [{ content: 'A', status: 'completed', activeForm: 'Doing A' }] })).toEqual([
      { content: 'A', status: 'completed', activeForm: 'Doing A' },
    ])
  })

  it('defaults an unknown status to pending and skips malformed items', () => {
    expect(parseTodos({ todos: [{ content: 'A', status: 'bogus' }, { status: 'completed' }, null, 'x'] })).toEqual([
      { content: 'A', status: 'pending', activeForm: undefined },
    ])
  })

  it('returns null for anything that is not a usable list', () => {
    expect(parseTodos(null)).toBeNull()
    expect(parseTodos({})).toBeNull()
    expect(parseTodos({ todos: 'nope' })).toBeNull()
    expect(parseTodos({ todos: [] })).toBeNull()
    expect(parseTodos({ todos: [{ content: '' }] })).toBeNull()
  })
})

describe('parseTaskCreate', () => {
  it('reads subject, activeForm and description', () => {
    expect(parseTaskCreate({ subject: 'S', activeForm: 'Doing S', description: 'D' })).toEqual({
      content: 'S',
      activeForm: 'Doing S',
      description: 'D',
    })
  })

  it('returns null without a subject', () => {
    expect(parseTaskCreate({ description: 'D' })).toBeNull()
    expect(parseTaskCreate({ subject: '' })).toBeNull()
    expect(parseTaskCreate(null)).toBeNull()
  })
})

describe('parseTaskUpdate', () => {
  it('reads a numeric taskId as a string', () => {
    expect(parseTaskUpdate({ taskId: 7, status: 'completed' })?.taskId).toBe('7')
  })

  it('carries only the fields it changes', () => {
    expect(parseTaskUpdate({ taskId: '1', subject: 'New' })).toEqual({
      taskId: '1',
      status: undefined,
      content: 'New',
      activeForm: undefined,
      description: undefined,
    })
  })

  it('keeps "deleted" as a status', () => {
    expect(parseTaskUpdate({ taskId: '1', status: 'deleted' })?.status).toBe('deleted')
  })

  it('drops an unknown status', () => {
    expect(parseTaskUpdate({ taskId: '1', status: 'bogus' })?.status).toBeUndefined()
  })

  it('returns null without a taskId', () => {
    expect(parseTaskUpdate({ status: 'completed' })).toBeNull()
    expect(parseTaskUpdate(null)).toBeNull()
  })
})

describe('toTodoItems', () => {
  it('orders by order and drops the bookkeeping fields', () => {
    const items: TodoItem[] = toTodoItems([
      entry({ key: 'b', content: 'Second', order: 2 }),
      entry({ key: 'a', content: 'First', order: 1 }),
    ])
    expect(items).toEqual([
      { content: 'First', status: 'completed', activeForm: undefined, description: undefined },
      { content: 'Second', status: 'completed', activeForm: undefined, description: undefined },
    ])
  })
})
