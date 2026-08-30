import { useState } from 'react'
import { hasDesktopBridge, setDesktopKeepRunning } from '../../lib/desktopBridge'
import { readLocal, StorageKeys, writeLocal } from '../../lib/storage'
import { EnabledToggle, SettingSection } from './shared'

export function DesktopLifetimeSection() {
  const [enabled, setEnabled] = useState(() => readLocal(StorageKeys.desktopKeepRunning) !== '0')
  if (!hasDesktopBridge()) return null
  const update = (next: boolean) => {
    setEnabled(next)
    writeLocal(StorageKeys.desktopKeepRunning, next ? null : '0')
    setDesktopKeepRunning(next)
    window.dispatchEvent(new CustomEvent('hydra-desktop-lifetime-changed', { detail: next }))
  }
  return (
    <SettingSection title="Run in background" description="Keep the desktop-owned Hydra backend and running chats available after the last window closes.">
      <EnabledToggle enabled={enabled} onChange={update} />
    </SettingSection>
  )
}
