import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { loadNotifyEnabled, useNotifyStore, fireNotification } from './notifyPrefs'
import { StorageKeys, readLocal } from './storage'

// A stand-in for the browser Notification API. jsdom doesn't implement it, so
// tests that exercise the granted path install this and inspect what was built.
class StubNotification {
  static permission: NotificationPermission = 'granted'
  static requestPermission = vi.fn(async () => StubNotification.permission)
  onclick: (() => void) | null = null
  close = vi.fn()
  constructor(
    public title: string,
    public options?: NotificationOptions,
  ) {
    StubNotification.instances.push(this)
  }
  static instances: StubNotification[] = []
  static reset() {
    StubNotification.instances = []
    StubNotification.requestPermission.mockClear()
  }
}

describe('loadNotifyEnabled', () => {
  beforeEach(() => localStorage.clear())

  it('defaults to false when nothing is stored', () => {
    expect(loadNotifyEnabled()).toBe(false)
  })

  it('is true only for the exact "1" flag', () => {
    localStorage.setItem(StorageKeys.desktopNotifications, '1')
    expect(loadNotifyEnabled()).toBe(true)
    localStorage.setItem(StorageKeys.desktopNotifications, 'true')
    expect(loadNotifyEnabled()).toBe(false)
  })
})

describe('useNotifyStore.setEnabled', () => {
  beforeEach(() => {
    localStorage.clear()
    useNotifyStore.setState({ enabled: false, permission: 'unsupported' })
  })
  afterEach(() => vi.unstubAllGlobals())

  it('grants and persists the flag when the browser allows it', async () => {
    StubNotification.permission = 'granted'
    StubNotification.reset()
    vi.stubGlobal('Notification', StubNotification)

    await useNotifyStore.getState().setEnabled(true)

    expect(useNotifyStore.getState().enabled).toBe(true)
    expect(useNotifyStore.getState().permission).toBe('granted')
    expect(readLocal(StorageKeys.desktopNotifications)).toBe('1')
  })

  it('stays off (and does not persist) when the browser denies', async () => {
    StubNotification.permission = 'default'
    StubNotification.requestPermission = vi.fn(async () => 'denied' as NotificationPermission)
    vi.stubGlobal('Notification', StubNotification)

    await useNotifyStore.getState().setEnabled(true)

    expect(useNotifyStore.getState().enabled).toBe(false)
    expect(useNotifyStore.getState().permission).toBe('denied')
    expect(readLocal(StorageKeys.desktopNotifications)).toBeNull()
  })

  it('clears the flag when turned off', async () => {
    localStorage.setItem(StorageKeys.desktopNotifications, '1')
    await useNotifyStore.getState().setEnabled(false)
    expect(useNotifyStore.getState().enabled).toBe(false)
    expect(readLocal(StorageKeys.desktopNotifications)).toBeNull()
  })
})

describe('fireNotification', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('does nothing when the preference is off', () => {
    StubNotification.reset()
    vi.stubGlobal('Notification', StubNotification)
    useNotifyStore.setState({ enabled: false, permission: 'granted' })

    fireNotification({ title: 't', body: 'b', tag: 'x', sticky: true, onClick: vi.fn() })
    expect(StubNotification.instances).toHaveLength(0)
  })

  it('builds a sticky, tagged notification whose click focuses and routes', () => {
    StubNotification.permission = 'granted'
    StubNotification.reset()
    vi.stubGlobal('Notification', StubNotification)
    const focus = vi.fn()
    vi.stubGlobal('focus', focus)
    useNotifyStore.setState({ enabled: true, permission: 'granted' })
    const onClick = vi.fn()

    fireNotification({ title: 'Agent needs input', body: 'blocked', tag: 'needs-input:a1', sticky: true, onClick })

    expect(StubNotification.instances).toHaveLength(1)
    const n = StubNotification.instances[0]
    expect(n.title).toBe('Agent needs input')
    expect(n.options).toMatchObject({ body: 'blocked', tag: 'needs-input:a1', requireInteraction: true })

    n.onclick?.()
    expect(focus).toHaveBeenCalled()
    expect(n.close).toHaveBeenCalled()
    expect(onClick).toHaveBeenCalled()
  })
})
