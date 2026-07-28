import React, { Fragment } from 'react'
import { BranchPill } from '../components/BranchPill'

// withBranchPills renders notification copy - toast messages, dialog titles and
// descriptions, caution notes - with `backtick` spans as inline mono pills. It is
// the one convention for naming a branch in prose: write the branch backticked at
// the call site ("Merge into `main`?") and it reads as a branch everywhere it is
// shown. Unpaired backticks stay literal; text without backticks passes through
// untouched.
//
// A pill carries 6px of its own horizontal padding, which is invisible next to a
// space but reads as a stray gap when the next character is punctuation that
// belongs to the pill's word - a title rendered "Merge into  main  ?" with the
// question mark adrift. So punctuation immediately after a pill is pulled back
// by most of that padding and kept on the pill's line.
const TRAILING_PUNCT = /^([?.,!:;)\]]+)([\s\S]*)$/

export function withBranchPills(text: string): React.ReactNode {
  const parts = text.split(/`([^`]*)`/) // odd indices are the quoted spans
  if (parts.length === 1) return text
  return parts.map((part, i) => {
    if (i % 2 === 1) return <BranchPill key={i}>{part}</BranchPill>
    const tight = i > 0 ? TRAILING_PUNCT.exec(part) : null
    if (!tight) return part
    return (
      <Fragment key={i}>
        <span className="-ml-1 whitespace-nowrap">{tight[1]}</span>
        {tight[2]}
      </Fragment>
    )
  })
}
