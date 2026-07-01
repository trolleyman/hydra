import { useEffect, useMemo, useRef, useState } from 'react'

export type ArtifactDim = { aspect: number; pxWidth: number; dpi: number }

// useArtifactDims measures each artifact's intrinsic aspect ratio and natural pixel
// width by loading the media off-screen, so the masonry can pick a sensible default
// span (wide → more columns, tall → one) and cap it so the shot is never blown up
// past its own resolution — all without the backend reporting dimensions. Images read
// naturalWidth/Height; videos read videoWidth/Height off a metadata preload. The
// browser caches the fetch, so the visible <img>/<video> doesn't load it twice.
// Returns a key→dims map that fills in as media loads.
export function useArtifactDims(sources: { key: string; url: string | null; video: boolean }[]): Record<string, ArtifactDim> {
  const [dims, setDims] = useState<Record<string, ArtifactDim>>({})
  // A stable signature of the (key,url) set so the effect only re-runs when the
  // media actually changes, not on every render's fresh array.
  const sig = sources.map((s) => `${s.key} ${s.url ?? ''}`).join('|')
  const ref = useRef(sources)
  // Keep the mirror current after commit (runs before the measurement effect
  // below on the same commit, so it reads the latest sources for a changed sig).
  useEffect(() => { ref.current = sources })
  useEffect(() => {
    let cancelled = false
    const set = (key: string, w: number, h: number) => {
      if (cancelled || !w || !h) return
      // Client-measured bytes carry no density, so dpi is 1 (logical == physical).
      setDims((a) => (a[key] != null ? a : { ...a, [key]: { aspect: w / h, pxWidth: w, dpi: 1 } }))
    }
    for (const s of ref.current) {
      if (!s.url) continue
      if (s.video) {
        const v = document.createElement('video')
        v.preload = 'metadata'
        v.onloadedmetadata = () => set(s.key, v.videoWidth, v.videoHeight)
        v.src = s.url
      } else {
        const img = new Image()
        img.onload = () => set(s.key, img.naturalWidth, img.naturalHeight)
        img.src = s.url
      }
    }
    return () => { cancelled = true }
  }, [sig])
  return dims
}

// useMediaDims resolves each artifact's dimensions, preferring the server-provided
// width/height (already carried in the artifact response — measured once at
// generation time and cached in meta.json, so no download) and falling back to
// measuring the bytes for any file the server didn't size: videos when ffprobe
// wasn't available, or entries cached before the server learned to record sizes.
// Files that already have server dims are excluded from the off-screen measurement,
// so for those the visible <img>'s loading="lazy" survives — a large diff no longer
// eagerly fetches every image up front just to lay out the grid.
export function useMediaDims(
  sources: { key: string; url: string | null; video: boolean; width?: number | null; height?: number | null; dpi?: number | null }[],
): Record<string, ArtifactDim> {
  const serverDims = useMemo(() => {
    const m: Record<string, ArtifactDim> = {}
    for (const s of sources) {
      if (s.width && s.height) m[s.key] = { aspect: s.width / s.height, pxWidth: s.width, dpi: s.dpi && s.dpi > 0 ? s.dpi : 1 }
    }
    return m
  }, [sources])
  const measureSources = useMemo(() => sources.filter((s) => !serverDims[s.key]), [sources, serverDims])
  const measured = useArtifactDims(measureSources)
  return useMemo(() => ({ ...measured, ...serverDims }), [measured, serverDims])
}
