// Reconstruction of the agent's plan / to-do list from its tool calls.
//
// Two tool families feed the same plan panel, and a session uses ONE of them:
//   TodoWrite - whole-list: every call carries the complete list, so it just
//               replaces what we hold.
//   Task*     - incremental: TaskCreate adds one task, TaskUpdate mutates one
//               by id. The list only exists as the sum of the calls so far.
//
// Kept apart from AgentChat so the reducer can be driven directly by tests: it
// owns no React state and no storage: callers pass the seed in and get the
// rebuilt list out via onChange (see planStore for the persistence around it).

import type { PlanEntry } from './planStore'

// One entry of the agent's plan as the panel displays it. `activeForm` is the
// present-tense label the CLI shows while a step is in progress ("Running
// tests").
export interface TodoItem {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
  activeForm?: string
  // TaskCreate's description (TodoWrite items carry none), shown in the plan
  // panel behind a per-row expander.
  description?: string
}

// parseTodos validates a TodoWrite tool input ({todos: [...]}), returning null
// for anything malformed so the call falls back to a normal tool card.
export function parseTodos(input: unknown): TodoItem[] | null {
  if (!input || typeof input !== 'object') return null
  const todos = (input as { todos?: unknown }).todos
  if (!Array.isArray(todos)) return null
  const out: TodoItem[] = []
  for (const t of todos) {
    if (!t || typeof t !== 'object') continue
    const o = t as Record<string, unknown>
    if (typeof o.content !== 'string' || !o.content) continue
    const status = o.status === 'in_progress' || o.status === 'completed' ? o.status : 'pending'
    out.push({ content: o.content, status, activeForm: typeof o.activeForm === 'string' ? o.activeForm : undefined })
  }
  return out.length ? out : null
}

// parseTaskCreate reads a TaskCreate input ({subject, ...}); a new task always
// starts `pending` (the harness assigns its id, which arrives in the result).
export function parseTaskCreate(input: unknown): { content: string; activeForm?: string; description?: string } | null {
  if (!input || typeof input !== 'object') return null
  const o = input as Record<string, unknown>
  if (typeof o.subject !== 'string' || !o.subject) return null
  return {
    content: o.subject,
    activeForm: typeof o.activeForm === 'string' ? o.activeForm : undefined,
    description: typeof o.description === 'string' && o.description ? o.description : undefined,
  }
}

// parseTaskUpdate reads a TaskUpdate input ({taskId, status?, subject?, ...}),
// returning the referenced id plus only the fields it changes (status "deleted"
// removes the task). Returns null when it names no task, so the call falls back
// to a normal tool card.
export function parseTaskUpdate(
  input: unknown,
): { taskId: string; status?: TodoItem['status'] | 'deleted'; content?: string; activeForm?: string; description?: string } | null {
  if (!input || typeof input !== 'object') return null
  const o = input as Record<string, unknown>
  const taskId = typeof o.taskId === 'string' ? o.taskId : typeof o.taskId === 'number' ? String(o.taskId) : ''
  if (!taskId) return null
  const status =
    o.status === 'pending' || o.status === 'in_progress' || o.status === 'completed' || o.status === 'deleted'
      ? o.status
      : undefined
  return {
    taskId,
    status,
    content: typeof o.subject === 'string' && o.subject ? o.subject : undefined,
    activeForm: typeof o.activeForm === 'string' ? o.activeForm : undefined,
    description: typeof o.description === 'string' && o.description ? o.description : undefined,
  }
}

// toTodoItems drops the bookkeeping (key/order) from persisted entries, leaving
// what the panel renders. Entries are ordered by `order`, not map insertion.
export function toTodoItems(entries: PlanEntry[]): TodoItem[] {
  return [...entries]
    .sort((a, b) => a.order - b.order)
    .map(({ content, status, activeForm, description }) => ({ content, status, activeForm, description }))
}

type TaskEntry = { content: string; status: TodoItem['status']; activeForm?: string; description?: string; order: number }

export interface PlanBuilder {
  // applyTaskTool folds a TaskCreate / TaskUpdate tool_use into the plan. Any
  // other tool name is ignored, so callers can hand it every block they see.
  applyTaskTool(name: string | undefined, input: unknown, toolUseId: string): void
  // applyTaskResult folds a TaskCreate's tool_result in - that is where the id
  // lives. Callers must skip error results.
  applyTaskResult(toolUseId: string, resultText: string): void
  // applyTodoWrite replaces the whole plan from a TodoWrite list.
  applyTodoWrite(list: TodoItem[]): void
  // adoptServer replaces the whole plan with the daemon's full-transcript
  // reconstruction (the chat "plan" frame). The frame is built from every
  // Task*/TodoWrite event in the transcript, so it supersedes whatever this
  // builder assembled from the backfill window or restored from storage.
  adoptServer(entries: PlanEntry[]): void
  // entries returns the current plan, ordered.
  entries(): PlanEntry[]
}

// createPlanBuilder builds the plan incrementally, calling onChange with the
// full ordered list after every change that touches it.
//
// `seed` is the persisted plan (keyed by real id) restored on connect, so a
// TaskUpdate whose TaskCreate has scrolled out of the replay window still finds
// its target and the panel isn't wiped to empty on reconnect.
export function createPlanBuilder(seed: PlanEntry[], onChange: (entries: PlanEntry[]) => void): PlanBuilder {
  const taskItems = new Map<string, TaskEntry>()
  let taskSeq = 0
  for (const e of seed) {
    taskItems.set(e.key, { content: e.content, status: e.status, activeForm: e.activeForm, description: e.description, order: e.order })
    taskSeq = Math.max(taskSeq, e.order)
  }
  // A session uses ONE planning tool, so the most recent tool wins: switching
  // from one to the other clears the old list. Inferred from the seeded keys on
  // restore.
  let planMode: 'todo' | 'task' | null = taskItems.size
    ? ([...taskItems.keys()].some((k) => k.startsWith('todo:')) ? 'todo' : 'task')
    : null

  const entries = (): PlanEntry[] =>
    [...taskItems.entries()].map(([key, v]) => ({ key, ...v })).sort((a, b) => a.order - b.order)
  const publish = () => onChange(entries())

  return {
    entries,
    applyTaskTool(name, input, toolUseId) {
      if (name === 'TaskCreate') {
        const t = parseTaskCreate(input)
        if (!t) return
        // Switching from a TodoWrite plan to Task* replaces it (latest tool wins).
        if (planMode === 'todo') {
          taskItems.clear()
          taskSeq = 0
        }
        planMode = 'task'
        taskSeq += 1
        // A TaskCreate's assigned id (#1, #2, ...) lives in its tool *result*,
        // not its input - and it is that id, not creation order, that a later
        // TaskUpdate references. So key it PROVISIONALLY by tool_use id here and
        // re-key once the result lands (applyTaskResult). Keying by creation
        // order broke once the replay window dropped early creates: the order
        // restarted at 1 while the real ids kept climbing, so every TaskUpdate
        // missed and the panel showed 0/N.
        taskItems.set(`use:${toolUseId}`, { content: t.content, status: 'pending', activeForm: t.activeForm, description: t.description, order: taskSeq })
        publish()
      } else if (name === 'TaskUpdate') {
        const u = parseTaskUpdate(input)
        if (!u) return
        // A TaskUpdate for a task we never saw created (e.g. its create predates
        // the replay window) has nothing to reflect yet.
        const cur = taskItems.get(u.taskId)
        if (!cur) return
        if (u.status === 'deleted') taskItems.delete(u.taskId)
        else {
          if (u.status) cur.status = u.status
          if (u.content) cur.content = u.content
          if (u.activeForm !== undefined) cur.activeForm = u.activeForm
          if (u.description !== undefined) cur.description = u.description
        }
        publish()
      }
    },
    applyTaskResult(toolUseId, resultText) {
      const provKey = `use:${toolUseId}`
      const cur = taskItems.get(provKey)
      if (!cur) return
      // "Task #17 created successfully: ..." -> "17".
      const m = /#(\d+)/.exec(resultText)
      const id = m ? m[1] : String(cur.order)
      taskItems.delete(provKey)
      // The real id often ALREADY exists: we seeded from the persisted entries
      // (keyed by real id) and the replay window then re-delivered the very
      // creates that produced them. That replayed create is the same task, not a
      // new one, so it folds into the seeded entry - which keeps its restored
      // status and order, both newer than this create's `pending`. Bailing out
      // here instead left the provisional entry stranded, and every restored
      // task showed twice: once completed, once as a pending clone.
      const existing = taskItems.get(id)
      if (existing) {
        existing.content = cur.content
        existing.activeForm = cur.activeForm
        existing.description = cur.description
      } else {
        taskItems.set(id, cur)
      }
      publish()
    },
    adoptServer(seed) {
      if (!seed.length) return
      taskItems.clear()
      taskSeq = 0
      for (const e of seed) {
        taskItems.set(e.key, { content: e.content, status: e.status, activeForm: e.activeForm, description: e.description, order: e.order })
        taskSeq = Math.max(taskSeq, e.order)
      }
      planMode = [...taskItems.keys()].some((k) => k.startsWith('todo:')) ? 'todo' : 'task'
      publish()
    },
    applyTodoWrite(list) {
      planMode = 'todo'
      taskItems.clear()
      taskSeq = 0
      // Keys are synthetic - TodoWrite carries no per-task id. Routed through
      // the same map so it persists + restores like a Task* plan.
      list.forEach((t, i) => {
        taskSeq = i + 1
        taskItems.set(`todo:${i}`, { content: t.content, status: t.status, activeForm: t.activeForm, description: t.description, order: taskSeq })
      })
      publish()
    },
  }
}
