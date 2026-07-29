import React, { Fragment } from 'react'
import { BranchPill } from '../components/BranchPill'

// Rendering notification copy - toast messages, dialog titles and descriptions,
// caution notes - with `backtick` spans as inline mono pills. It is the one
// convention for naming a branch in prose: write the branch backticked at the
// call site ("Merge into `main`?") and it reads as a branch everywhere it is
// shown.
//
// Two entry points, and which one you want depends on where the string came
// from:
//
//   withBranchPills(text)   - the whole string is copy WE wrote.
//   pillText`...${value}`   - copy with untrusted text interpolated into it.
//
// See pillText for why the distinction matters.

// A pill carries 6px of its own horizontal padding, which is invisible next to a
// space but reads as a stray gap when the next character is punctuation that
// belongs to the pill's word - a title rendered "Merge into  main  ?" with the
// question mark adrift. So punctuation immediately after a pill is pulled back
// by most of that padding and kept on the pill's line.
const TRAILING_PUNCT = /^([?.,!:;)\]]+)([\s\S]*)$/

// One segment of the output: a run of literal text, a value spliced in verbatim,
// or a pill boundary.
type Token = { kind: 'text'; text: string } | { kind: 'value'; node: React.ReactNode } | { kind: 'tick' }

// scan turns authored copy into text runs and pill boundaries. An unpaired
// backtick is handled by the renderer, which drops back to literal text.
function scan(authored: string): Token[] {
  const out: Token[] = []
  let buf = ''
  for (const ch of authored) {
    if (ch === '`') {
      if (buf) { out.push({ kind: 'text', text: buf }); buf = '' }
      out.push({ kind: 'tick' })
    } else {
      buf += ch
    }
  }
  if (buf) out.push({ kind: 'text', text: buf })
  return out
}

// render walks the token stream, opening a pill on each backtick and closing it
// on the next. A trailing unclosed backtick means the copy was malformed, so the
// contents fall back to literal text (including the backtick itself) rather than
// silently swallowing the rest of the message.
function render(tokens: Token[]): React.ReactNode {
  const out: React.ReactNode[] = []
  // Buffer for the pill currently being collected, or null when outside one.
  let pill: React.ReactNode[] | null = null
  let key = 0
  // Set right after a pill closes, so the next text run can tighten its leading
  // punctuation against it.
  let justClosed = false

  const pushText = (text: string) => {
    if (pill === null && justClosed) {
      const tight = TRAILING_PUNCT.exec(text)
      if (tight) {
        out.push(<span key={key++} className="-ml-1 whitespace-nowrap">{tight[1]}</span>)
        if (tight[2]) out.push(<Fragment key={key++}>{tight[2]}</Fragment>)
        justClosed = false
        return
      }
    }
    ;(pill ?? out).push(<Fragment key={key++}>{text}</Fragment>)
    justClosed = false
  }

  for (const t of tokens) {
    if (t.kind === 'tick') {
      if (pill === null) {
        pill = []
      } else {
        out.push(<BranchPill key={key++}>{pill}</BranchPill>)
        pill = null
        justClosed = true
      }
      continue
    }
    if (t.kind === 'text') {
      pushText(t.text)
    } else {
      // A spliced value never tightens punctuation against a preceding pill -
      // that rule is about copy, and this is data.
      ;(pill ?? out).push(<Fragment key={key++}>{t.node}</Fragment>)
      justClosed = false
    }
  }
  // Unclosed pill: put the backtick back and emit what we collected as literal.
  if (pill !== null) {
    out.push(<Fragment key={key++}>{'`'}</Fragment>, ...pill)
  }
  return out
}

// withBranchPills renders a string that is entirely copy we wrote. Text without
// backticks passes through untouched.
export function withBranchPills(text: string): React.ReactNode {
  if (!text.includes('`')) return text
  return render(scan(text))
}

// pillText is withBranchPills for copy with UNTRUSTED text interpolated into it -
// an API error sentence, a project name, a file path.
//
// The problem it solves: withBranchPills parses whatever string it is handed, and
// a message built as `Sync failed: ${formatError(err)}` hands it authored copy and
// server text glued together. A backtick anywhere in that server text opens a
// pill around the next run of characters, so a failure message can render
// fragments of itself as fake branch names. Cosmetic - the segments land as text
// in a span, never as HTML - but wrong, and invisible from the call site.
//
// As a tagged template the split is structural rather than conventional: the
// STATIC chunks are copy someone wrote, so they are scanned for backticks; the
// ${values} are data, so they are spliced in verbatim and can never open or close
// a pill.
//
//   pillText`Sync failed: ${detail}`        // detail is inert, whatever is in it
//   pillText`Merged into \`${branch}\``     // still a pill - those backticks are
//                                           // authored, and the value sits inside
//
// So a value can still be wrapped in a pill by the copy around it, which is what
// nearly every branch-name site wants. What it cannot do is invent a pill of its
// own.
export function pillText(strings: TemplateStringsArray, ...values: unknown[]): React.ReactNode {
  const tokens: Token[] = []
  strings.forEach((chunk, i) => {
    tokens.push(...scan(chunk))
    if (i < values.length) {
      const v = values[i]
      tokens.push({ kind: 'value', node: v == null ? '' : String(v) })
    }
  })
  return render(tokens)
}
