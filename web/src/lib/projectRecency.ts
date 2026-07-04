// Most-recently-visited ordering of projects, persisted to localStorage. This is
// what the Ctrl+` alt-tab switcher sorts by: the current project sits at the
// front (it was just visited), so a single tap lands on the previously-used one,
// exactly like a window switcher. Nothing tracked this before - projects were
// cycled in the server's list order.

import { StorageKeys, readJSON, writeJSON } from './storage'

const MAX = 100

function load(): string[] {
  return (
    readJSON<string[]>(StorageKeys.projectRecency, (v) =>
      Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : null,
    ) ?? []
  )
}

// Record that a project was just visited, moving it to the front of the order.
export function touchProject(id: string): void {
  if (!id) return
  const next = [id, ...load().filter((x) => x !== id)].slice(0, MAX)
  writeJSON(StorageKeys.projectRecency, next)
}

// Return the given projects sorted most-recently-visited first. Projects with no
// recorded visit keep their original relative order, appended after the ranked
// ones (a stable sort by rank, unseen = +Infinity).
export function recencyOrder<T extends { id: string }>(projects: T[]): T[] {
  const rank = new Map(load().map((id, i) => [id, i]))
  return projects
    .map((p, i) => ({ p, i, r: rank.has(p.id) ? (rank.get(p.id) as number) : Infinity }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.p)
}
