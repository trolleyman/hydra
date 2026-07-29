import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { useServerMediaSize, clearServerMediaSizeState } from './serverMediaSize'
import { clearMediaSizes, recallMediaSize } from './mediaSize'

// Asking the backend how big a chat picture is, so its box can be reserved
// before the bytes arrive. The two properties worth pinning: the answer lands in
// the shared cache under the URL everything else uses, and a transcript full of
// images asks ONCE rather than once per picture (on HTTP/1.1 a request per image
// would queue behind the image downloads it is supposed to get ahead of).

const CTX = { projectId: 'p1', agentId: 'a1' }
const URL_FOR = (p: string) => `/agent-files/projects/p1/agents/a1/blob?path=${encodeURIComponent(p)}`

function stubFetch(sizes: Record<string, { width: number; height: number }>) {
  const fetchMock = vi.fn(async () => ({
    ok: true,
    json: async () => ({ sizes }),
  }))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('useServerMediaSize', () => {
  beforeEach(() => {
    clearMediaSizes()
    clearServerMediaSizeState()
  })
  afterEach(() => vi.unstubAllGlobals())

  it('remembers the size against the url the picture is loaded from', async () => {
    stubFetch({ '/tmp/shot.png': { width: 780, height: 1688 } })
    const { result } = renderHook(() => useServerMediaSize(URL_FOR('/tmp/shot.png'), '/tmp/shot.png', CTX))
    await waitFor(() => expect(result.current).toEqual({ w: 780, h: 1688 }))
    // ...which is the key the lightbox will look it up by when the picture is
    // clicked, so it needs no measuring of its own.
    expect(recallMediaSize(URL_FOR('/tmp/shot.png'))).toEqual({ w: 780, h: 1688 })
  })

  it('asks once for every picture in a render', async () => {
    const fetchMock = stubFetch({
      '/tmp/a.png': { width: 10, height: 20 },
      '/tmp/b.png': { width: 30, height: 40 },
    })
    const { result } = renderHook(() => [
      useServerMediaSize(URL_FOR('/tmp/a.png'), '/tmp/a.png', CTX),
      useServerMediaSize(URL_FOR('/tmp/b.png'), '/tmp/b.png', CTX),
    ])
    await waitFor(() => expect(result.current[1]).toEqual({ w: 30, h: 40 }))
    expect(result.current[0]).toEqual({ w: 10, h: 20 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, { body: string }])[1].body)
    expect(body.paths.sort()).toEqual(['/tmp/a.png', '/tmp/b.png'])
  })

  it('does not ask again for a path it has already asked about', async () => {
    const fetchMock = stubFetch({ '/tmp/a.png': { width: 10, height: 20 } })
    const first = renderHook(() => useServerMediaSize(URL_FOR('/tmp/a.png'), '/tmp/a.png', CTX))
    await waitFor(() => expect(first.result.current).toEqual({ w: 10, h: 20 }))
    renderHook(() => useServerMediaSize(URL_FOR('/tmp/a.png'), '/tmp/a.png', CTX))
    await Promise.resolve()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('still applies the answer to an image that re-mounted while it was in flight', async () => {
    // The regression this hook was rewritten for. A chat row unmounts and mounts
    // again constantly as the transcript grows, and the first version delivered
    // the answer through a callback the pending request had captured - so a
    // re-mount in that window dropped it on the floor: the size landed, nothing
    // re-rendered, and the picture kept the box it never had. Subscribing to the
    // cache instead means whoever is mounted when it lands is told.
    let release: (v: unknown) => void = () => {}
    const gate = new Promise((r) => { release = r })
    vi.stubGlobal('fetch', vi.fn(async () => {
      await gate
      return { ok: true, json: async () => ({ sizes: { '/tmp/a.png': { width: 10, height: 20 } } }) }
    }))
    // Ask, then throw that instance away before the answer arrives...
    const first = renderHook(() => useServerMediaSize(URL_FOR('/tmp/a.png'), '/tmp/a.png', CTX))
    first.unmount()
    // ...and mount a fresh one, as the re-rendered transcript does.
    const second = renderHook(() => useServerMediaSize(URL_FOR('/tmp/a.png'), '/tmp/a.png', CTX))
    expect(second.result.current).toBeNull()
    release(null)
    await waitFor(() => expect(second.result.current).toEqual({ w: 10, h: 20 }))
  })

  it('gives up quietly on a path the backend cannot measure', async () => {
    // Absent from the answer, not zero - the caller falls back to decoding the
    // image itself, which is what it did before this existed. Re-asking would be
    // a request per render for a message full of unreadable paths.
    const fetchMock = stubFetch({})
    const { result, rerender } = renderHook(() => useServerMediaSize(URL_FOR('/tmp/gone.png'), '/tmp/gone.png', CTX))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    rerender()
    expect(result.current).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('asks nothing for a picture with no file behind it', async () => {
    // A data:/blob: URL, or a surface with no head: there is nothing on disk for
    // the backend to measure, so the only answer available is a local decode.
    const fetchMock = stubFetch({})
    renderHook(() => useServerMediaSize(null, '/tmp/a.png', CTX))
    renderHook(() => useServerMediaSize(URL_FOR('/tmp/a.png'), '/tmp/a.png', { projectId: 'p1' }))
    await Promise.resolve()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
