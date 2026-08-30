import { useState } from 'react'
import { hasDesktopBridge, setDesktopKeepRunning } from '../../lib/desktopBridge'
import { readLocal, StorageKeys, writeLocal } from '../../lib/storage'
import { useProjectStore } from '../../stores/projectStore'
import { EnabledToggle, SettingSection } from './shared'

export function DesktopLifetimeSection() {
  const [enabled, setEnabled] = useState(() => readLocal(StorageKeys.desktopKeepRunning) !== '0')
  const commandOwned = useProjectStore((state) => state.systemStatus?.backend_lifetime === 'command-owned')
  if (!hasDesktopBridge()) return null
  const update = (next: boolean) => {
    setEnabled(next)
    writeLocal(StorageKeys.desktopKeepRunning, next ? null : '0')
    setDesktopKeepRunning(next)
    window.dispatchEvent(new CustomEvent('hydra-desktop-lifetime-changed', { detail: next }))
  }
  return (
    <SettingSection
      title="Run in background"
      description={commandOwned
        ? 'Unavailable for a command-owned backend, which stops when its desktop command exits.'
        : 'Keep the desktop-owned Hydra backend and running chats available after the last window closes.'}
    >
      <EnabledToggle enabled={commandOwned ? false : enabled} onChange={update} disabled={commandOwned} />
    </SettingSection>
  )
}
