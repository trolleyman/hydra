import { useMemo } from 'react'
import { stripAnsi, hasAnsi, ansiToHtml } from '../lib/ansi'

// AnsiText renders captured tool output that may carry ANSI escapes - a test
// case's failure message, a runner's error text - without ever showing the raw
// escape bytes. Test runners colour their output (go test's red FAIL, the
// dimmed "$ <command>" echo), and dropping that straight into JSX printed the
// codes as literal garbage: "[0m[2m[35m$ [0m[2m[1mgit -C ...".
//
// Coloured output keeps its colour, rendered to themed spans - the same path
// the chat's Bash output takes (see OutputPanel in AgentChat.tsx). Anything
// else is stripped to plain text, so a stray escape can never leak through.
// ansiToHtml escapes HTML itself, so the innerHTML write carries no markup
// from the runner.
//
// The build log proper does NOT come through here: LogView pipes it into
// xterm, which interprets ANSI natively.
export function AnsiText({ text, className }: { text: string; className?: string }) {
  const html = useMemo(() => (hasAnsi(text) ? ansiToHtml(text) : null), [text])
  if (html != null) return <pre className={className} dangerouslySetInnerHTML={{ __html: html }} />
  return <pre className={className}>{stripAnsi(text)}</pre>
}
