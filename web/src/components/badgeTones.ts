import type { Tone } from './Badge'
import type { TestStatus } from '../api/models/TestStatus'

// Color tones are the single source of truth for agent status / session /
// end-state colors. Each tone knows how to paint itself two ways: as a solid
// status `dot` (TONE_DOT) and as a soft text `badge` (TONE_BADGE — light fill +
// readable text, with dark-mode variants). Because both presentations come from
// the same tone, a status dot and its badge can never drift out of sync.
export const TONE_DOT: Record<Tone, string> = {
  green: 'bg-green-500',
  blue: 'bg-blue-400',
  indigo: 'bg-indigo-400',
  yellow: 'bg-yellow-400',
  violet: 'bg-violet-500',
  red: 'bg-red-500',
  redSoft: 'bg-red-400',
  neutral: 'bg-gray-300 dark:bg-gray-600',
  muted: 'bg-gray-300 dark:bg-gray-600',
  faint: 'bg-gray-300 dark:bg-gray-600',
}

export const TONE_BADGE: Record<Tone, string> = {
  green: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
  blue: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
  indigo: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400',
  yellow: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400',
  violet: 'bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-400',
  red: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
  redSoft: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
  neutral: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400',
  muted: 'bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400',
  faint: 'bg-gray-50 text-gray-400 dark:bg-gray-800 dark:text-gray-500',
}

// Verdict → tone, the single source of truth for the test-gate chip colors
// (PLAN #68, design 2026-06-29). passing=green, failing=red, running=blue,
// errored=YELLOW (a "couldn't run / we don't know" caution, with a warning
// triangle — distinct from a red failure), stale=gray (dashed). Skipped is NEVER
// its own verdict and renders GRAY inline (amber would imply a warning a skipped
// test doesn't warrant — per user).
export function verdictTone(status: TestStatus): Tone {
  switch (status) {
    case 'passing':
      return 'green'
    case 'failing':
      return 'red'
    case 'running':
      return 'blue'
    case 'errored':
      return 'yellow'
    default:
      return 'neutral' // stale / none
  }
}
