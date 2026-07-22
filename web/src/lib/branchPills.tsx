import React from 'react'
import { BranchPill } from '../components/BranchPill'

// withBranchPills renders toast/notification copy with `backtick` spans as inline
// mono pills (branch names - "Synced with `origin/main`", "merged into `main`"),
// matching how the dialogs embed branch names mid-sentence. Unpaired backticks
// stay literal; text without backticks passes through untouched.
export function withBranchPills(text: string): React.ReactNode {
  const parts = text.split(/`([^`]*)`/) // odd indices are the quoted spans
  if (parts.length === 1) return text
  return parts.map((part, i) => (i % 2 === 1 ? <BranchPill key={i}>{part}</BranchPill> : part))
}
