import { useCallback, useRef, useState } from 'react'
import { copyText } from './clipboard'

export type CopyState = 'idle' | 'ok' | 'err'

// useCopyFlash drives the transient Copy -> Check/X feedback shared by every copy
// button: the diff-header path button, the branch tag, the repository file
// actions, and the test-tree rows. `copy(text)` writes via copyText - which is
// insecure-LAN-origin safe and reports success as a boolean rather than throwing
// - and flips state to 'ok'/'err' for `duration` ms so the icon shows a green
// tick or a red X. The ref-based timer makes rapid clicks debounce-safe.
//
// `flash(ok)` is the manual entry point for callers that own the write
// themselves (e.g. copying an image via copyImageToClipboard, or a helper like
// copyBranchName that also raises a toast) and just need the icon feedback.
//
// Pair it with CopyStateIcon (components/CopyStateIcon.tsx) for the visuals.
export function useCopyFlash(duration = 1500) {
  const [state, setState] = useState<CopyState>('idle')
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const flash = useCallback((ok: boolean) => {
    setState(ok ? 'ok' : 'err')
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setState('idle'), duration)
  }, [duration])

  const copy = useCallback(async (text: string): Promise<boolean> => {
    // copyText already swallows its own failures and returns false, but guard
    // anyway so the flash is guaranteed to reflect the true outcome even if a
    // future change lets something throw.
    let ok: boolean
    try {
      ok = await copyText(text)
    } catch {
      ok = false
    }
    flash(ok)
    return ok
  }, [flash])

  return { state, copy, flash }
}
