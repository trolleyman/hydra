// The whitespace-marks preference: which whitespace the code surfaces draw a
// mark on. Client-only and global (localStorage, like Theme), stored as the bare
// mode string with the default ('off') removing the key.
//
// The marking itself - and what each mode means - is lib/whitespaceMarks; this
// module is only where the choice lives.
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { readLocal, singleFieldStorage, StorageKeys, writeLocal } from './storage'
import type { WhitespaceMarks } from './whitespaceMarks'

// Reads the persisted mode. Absent or unrecognised = 'off', the default.
// Exported for non-React callers / unit testing.
export function loadWhitespaceMarks(): WhitespaceMarks {
  const raw = readLocal(StorageKeys.codeWhitespace)
  return raw === 'boundary' || raw === 'all' ? raw : 'off'
}

interface WhitespaceState {
  marks: WhitespaceMarks
  setMarks: (marks: WhitespaceMarks) => void
}

export const useWhitespaceStore = create<WhitespaceState>()(
  persist(
    (set) => ({
      marks: loadWhitespaceMarks(),
      setMarks: (marks) => set({ marks }),
    }),
    {
      name: StorageKeys.codeWhitespace,
      storage: singleFieldStorage('marks', loadWhitespaceMarks, (marks) =>
        writeLocal(StorageKeys.codeWhitespace, marks === 'off' ? null : marks),
      ),
      partialize: (s) => ({ marks: s.marks }),
    },
  ),
)

// useWhitespaceMarks is the read-only form every code surface uses: one field,
// so a component re-renders when the mode changes and not when anything else in
// this browser's preferences does.
export function useWhitespaceMarks(): WhitespaceMarks {
  return useWhitespaceStore((s) => s.marks)
}
