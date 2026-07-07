import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { loadNotifyEnabled, useNotifyStore, fireNotification, dismissNotification } from './notifyPrefs'
import { StorageKeys, readLocal } from './storage'

// A stand-in for the browser Notification API. jsdom doesn't implement it, so
// tests that exercise the granted path install this and inspect what was built.
class StubNotification {
  static permission: NotificationPermission = 'granted'
  static requestPermission = vi.fn(async () => StubNotification.permission)
  onclick: (() => void) | null = null
  onclose: (() => void) | null = null
  close = vi.fn(function (this: StubNotification) {
    // Mirror the browser: closing fires the close event (which our helper uses
    // to forget the notification).
    this.onclose?.()
  })
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

describe('dismissNotification', () => {
  beforeEach(() => {
    StubNotification.permission = 'granted'
    StubNotification.reset()
    vi.stubGlobal('Notification', StubNotification)
    useNotifyStore.setState({ enabled: true, permission: 'granted' })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('closes an OS notification previously fired under the same tag', () => {
    fireNotification({ title: 't', body: 'b', tag: 'needs-input:a1', sticky: true, onClick: vi.fn() })
    const n = StubNotification.instances[0]

    dismissNotification('needs-input:a1')
    expect(n.close).toHaveBeenCalledTimes(1)
  })

  it('is a no-op for a tag that was never fired', () => {
    expect(() => dismissNotification('needs-input:never')).not.toThrow()
  })

  it('does not close again once the notification was dismissed', () => {
    fireNotification({ title: 't', body: 'b', tag: 'approval:a1:r1', sticky: true, onClick: vi.fn() })
    const n = StubNotification.instances[0]

    dismissNotification('approval:a1:r1')
    dismissNotification('approval:a1:r1')
    expect(n.close).toHaveBeenCalledTimes(1)
  })

  it('tracks only the newest notification when a tag is re-fired', () => {
    fireNotification({ title: 't1', body: 'b', tag: 'needs-input:a1', sticky: true, onClick: vi.fn() })
    fireNotification({ title: 't2', body: 'b', tag: 'needs-input:a1', sticky: true, onClick: vi.fn() })
    const [first, second] = StubNotification.instances

    dismissNotification('needs-input:a1')
    // The replacement is the one on screen, so it (not the retired first) is closed.
    expect(second.close).toHaveBeenCalledTimes(1)
    expect(first.close).not.toHaveBeenCalled()
  })

  it('auto-dismisses after autoDismissMs and stops tracking it', () => {
    vi.useFakeTimers()
    fireNotification({
      title: 't',
      body: 'b',
      tag: 'needs-input:a1',
      sticky: true,
      autoDismissMs: 120_000,
      onClick: vi.fn(),
    })
    const n = StubNotification.instances[0]

    expect(n.close).not.toHaveBeenCalled()
    vi.advanceTimersByTime(120_000)
    expect(n.close).toHaveBeenCalledTimes(1)

    // Already gone: a later dismiss is a no-op (no second close).
    dismissNotification('needs-input:a1')
    expect(n.close).toHaveBeenCalledTimes(1)
  })

  it('cancels the auto-dismiss timer when dismissed early', () => {
    vi.useFakeTimers()
    fireNotification({
      title: 't',
      body: 'b',
      tag: 'needs-input:a1',
      sticky: true,
      autoDismissMs: 120_000,
      onClick: vi.fn(),
    })
    const n = StubNotification.instances[0]

    dismissNotification('needs-input:a1')
    expect(n.close).toHaveBeenCalledTimes(1)
    // The pending timer must not fire a second close after early dismissal.
    vi.advanceTimersByTime(120_000)
    expect(n.close).toHaveBeenCalledTimes(1)
  })
})
