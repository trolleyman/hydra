// Gradle suppresses colour when its output is captured instead of attached to a
// terminal. Add back a small, stable set of semantic colours for the lines that
// are unmistakably Gradle output. This is deliberately not a general log
// highlighter: unrecognised text stays byte-for-byte unchanged.

const RESET = '\x1b[0m'
const DIM = '\x1b[2m'
const BOLD = '\x1b[1m'
const RED = '\x1b[31m'
const GREEN = '\x1b[32m'
const YELLOW = '\x1b[33m'
const BLUE = '\x1b[34m'

const TASK_DISPOSITION: Record<string, string> = {
  'UP-TO-DATE': DIM,
  'FROM-CACHE': DIM,
  'NO-SOURCE': DIM,
  SKIPPED: YELLOW,
  FAILED: RED,
}

// colorizeGradleLogLine returns an ANSI-coloured line when the shape is specific
// to Gradle, or null when the caller should render the original line.
export function colorizeGradleLogLine(line: string): string | null {
  const task = /^(> Task )(:\S+?)(?: (UP-TO-DATE|FROM-CACHE|NO-SOURCE|SKIPPED|FAILED))?$/.exec(line)
  if (task) {
    const disposition = task[3]
    return `${DIM}${task[1]}${RESET}${BLUE}${task[2]}${RESET}${
      disposition ? ` ${TASK_DISPOSITION[disposition]}${disposition}${RESET}` : ''
    }`
  }

  if (/^BUILD SUCCESSFUL(?: |$)/.test(line)) {
    return `${BOLD}${GREEN}${line}${RESET}`
  }
  if (/^BUILD FAILED(?: |$)/.test(line) || /^FAILURE: Build failed with an exception\.$/.test(line)) {
    return `${BOLD}${RED}${line}${RESET}`
  }

  const actions = /^(\d+ actionable tasks:)(.*)$/.exec(line)
  if (actions) {
    return `${DIM}${actions[1]}${RESET}${actions[2]}`
  }

  return null
}
