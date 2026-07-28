// Carrying a tool_result to a card that has not been built yet.
//
// The chat loads older history in pages, NEWEST first. A tool call whose
// tool_use and tool_result straddle a page boundary is therefore reduced
// result-first: the batch carrying the result is reduced pages before the batch
// that builds the card it belongs to. A patch that found no card used to drop
// the result on the floor, and nothing ever re-applied it - so scrolling back
// to an answered AskUserQuestion showed a blank, still-interactive card with no
// record of the selection (and a split Bash card showed no output).
//
// A ToolResultLink is the connection-scoped bridge: `known` is every tool_use
// id a card was built for, `orphans` the results still waiting for theirs.

// `raw` is the provider's own tool_result block, carried alongside the parsed
// text so a card built by a later page still gets a truthful Raw panel.
export type OrphanResult = { result: string; isError: boolean; images: string[]; raw?: unknown }

export type ToolResultLink = { known: Set<string>; orphans: Map<string, OrphanResult> }

export function newToolResultLink(): ToolResultLink {
  return { known: new Set(), orphans: new Map() }
}

// Results for cards the reducers deliberately never build (an older TodoWrite,
// whose state the plan panel already holds) are never claimed, so the map is
// bounded and drops its oldest entries.
export const MAX_ORPHAN_RESULTS = 500

export function stashOrphanResult(link: ToolResultLink | undefined, toolUseId: string, orphan: OrphanResult) {
  if (!link || !toolUseId) return
  link.orphans.set(toolUseId, orphan)
  while (link.orphans.size > MAX_ORPHAN_RESULTS) {
    const oldest = link.orphans.keys().next().value
    if (oldest === undefined) break
    link.orphans.delete(oldest)
  }
}

// claimOrphanResult records a freshly built tool/question card's id and applies
// any result that arrived before it. Returns a patched copy when one was
// waiting, the item itself otherwise. Generic over the card shape so this stays
// free of the chat's item union.
export function claimOrphanResult<T extends { kind: string; toolUseId?: string }>(
  link: ToolResultLink | undefined,
  item: T,
): T {
  if (!link || (item.kind !== 'tool' && item.kind !== 'question') || !item.toolUseId) return item
  link.known.add(item.toolUseId)
  const orphan = link.orphans.get(item.toolUseId)
  if (!orphan) return item
  link.orphans.delete(item.toolUseId)
  // A question card carries only the answer text; a tool card also its error
  // flag and any images the result embedded.
  if (item.kind === 'question') return { ...item, result: orphan.result }
  return {
    ...item,
    result: orphan.result,
    isError: orphan.isError,
    resultImages: orphan.images.length ? orphan.images : undefined,
    rawResult: orphan.raw,
  }
}
