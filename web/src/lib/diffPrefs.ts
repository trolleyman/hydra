// Browser-wide choices for the number of unchanged lines shown around each
// change. The agent and repository diff viewers share the same preference.
export const DIFF_CONTEXT_OPTIONS = [3, 5, 7, 10] as const

export type DiffContextLines = (typeof DIFF_CONTEXT_OPTIONS)[number]

export const DEFAULT_DIFF_CONTEXT_LINES: DiffContextLines = 3

export function parseDiffContextLines(value: string | null): DiffContextLines {
  const parsed = Number(value)
  return DIFF_CONTEXT_OPTIONS.find((option) => option === parsed) ?? DEFAULT_DIFF_CONTEXT_LINES
}
