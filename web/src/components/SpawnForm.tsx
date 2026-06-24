import { useState, useRef, useEffect, useCallback } from 'react'
import { api } from '../stores/apiClient'
import type { AgentResponse, SpawnAgentRequest, RepositoryBranch } from '../api'
import { BranchSelector } from './BranchSelector'
import { formatError } from '../api/format_error'
import { uploadFile, extractFiles, isImageFile } from '../api/uploads'
import { Zap, LoaderCircle, Paperclip, Check } from 'lucide-react'
import { AgentTypeIcon, AGENT_ACCENT } from './AgentTypeIcon'
import { Tooltip } from './Tooltip'
import { ImageLightbox } from './ImageLightbox'
import { AttachmentChips } from './AttachmentChips'
import { StorageKeys, promptDraftKey, promptScrollKey, imageCounterKey, readLocal, writeLocal } from '../lib/storage'
import { HighlightedTextarea } from '../lib/markdown'
import { type Attachment, spawnDraftKey, loadAttachments, saveAttachments, nextAttachmentId } from '../lib/spawnDrafts'

type AgentTypeOption = 'claude' | 'gemini' | 'copilot' | 'codex'

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/i.test(navigator.platform)

function slugify(text: string, maxLength = 40, allowTrailingHyphen = false): string {
  let slug = text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')

  if (slug.length > maxLength) {
    const lastHyphen = slug.lastIndexOf('-', maxLength)
    if (lastHyphen > 0) {
      slug = slug.slice(0, lastHyphen)
    } else {
      slug = slug.slice(0, maxLength)
    }
  }

  return allowTrailingHyphen ? slug : slug.replace(/-$/, '')
}

function generateId(prompt: string): string {
  const words = prompt.trim().split(/\s+/).slice(0, 8).join(' ')
  return slugify(words)
}

// Selectable agent types with their display label. The AgentTypeOption ids line
// up with AgentTypeIcon's names, so the icon and its brand accent colour
// (AGENT_ACCENT) can both be rendered directly from the id.
const AGENT_TYPES: { id: AgentTypeOption; label: string; color: string }[] = [
  { id: 'claude', label: 'Claude', color: AGENT_ACCENT.claude },
  { id: 'gemini', label: 'Gemini', color: AGENT_ACCENT.gemini },
  { id: 'copilot', label: 'Copilot', color: AGENT_ACCENT.copilot },
  { id: 'codex', label: 'Codex', color: AGENT_ACCENT.codex },
]

// AgentTypePicker is an icon-only trigger that opens a dropdown listing each
// agent type as its icon + name. Used in both SpawnForm layouts so the agent
// selector stays compact (just the brand mark) while still being discoverable.
function AgentTypePicker({
  value,
  onChange,
  size = 'md',
}: {
  value: AgentTypeOption
  onChange: (t: AgentTypeOption) => void
  size?: 'sm' | 'md'
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  // Menu coordinates. The spawn cards clip their content (overflow-hidden for
  // the rounded gradient border), so the menu is positioned with `fixed` and
  // anchored to the trigger's rect to escape that clipping.
  const [coords, setCoords] = useState<{ left: number; top: number } | null>(null)

  const place = useCallback(() => {
    const r = btnRef.current?.getBoundingClientRect()
    if (r) setCoords({ left: r.left, top: r.bottom + 4 })
  }, [])

  useEffect(() => {
    if (!open) return
    place()
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    // Keep the menu pinned to the trigger if the page scrolls or resizes.
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    return () => {
      document.removeEventListener('mousedown', handleClick)
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
  }, [open, place])

  const active = AGENT_TYPES.find((a) => a.id === value) ?? AGENT_TYPES[0]
  const trigger = size === 'sm' ? 'w-6 h-6' : 'w-7 h-7'
  const iconCls = size === 'sm' ? 'w-3.5 h-3.5' : 'w-4 h-4'

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        ref={btnRef}
        type="button"
        title={`Agent: ${active.label}`}
        aria-label={`Agent type: ${active.label}`}
        onClick={() => setOpen((o) => !o)}
        className={`flex items-center justify-center rounded-full border transition-colors cursor-pointer ${trigger} ${active.color} ${
          open
            ? 'bg-gray-100 dark:bg-gray-700 border-gray-300 dark:border-gray-600'
            : 'border-transparent hover:bg-gray-100 dark:hover:bg-gray-700'
        }`}
      >
        <AgentTypeIcon name={active.id} className={iconCls} />
      </button>
      {open && coords && (
        <div
          style={{ position: 'fixed', left: coords.left, top: coords.top }}
          className="w-36 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg z-50 py-1"
        >
          {AGENT_TYPES.map((a) => (
            <button
              key={a.id}
              type="button"
              onClick={() => { onChange(a.id); setOpen(false) }}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-xs text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700/60 transition-colors cursor-pointer"
            >
              <AgentTypeIcon name={a.id} className={`w-4 h-4 shrink-0 ${a.color}`} />
              <span>{a.label}</span>
              {a.id === value && <Check className="w-3.5 h-3.5 ml-auto shrink-0 text-blue-500" />}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export function SpawnForm({
  projectId,
  onSpawned,
  compact = false,
  disabled = false,
}: {
  projectId: string | null
  onSpawned?: (agent: AgentResponse) => void
  compact?: boolean
  disabled?: boolean
}) {
  const [prompt, setPrompt] = useState('')
  const [agentId, setAgentId] = useState('')
  const [idManuallyEdited, setIdManuallyEdited] = useState(false)
  const [agentType, setAgentType] = useState<AgentTypeOption>(() => {
    const saved = readLocal(StorageKeys.defaultAgentType)
    if (saved && (saved === 'claude' || saved === 'gemini' || saved === 'copilot' || saved === 'codex')) {
      return saved as AgentTypeOption
    }
    return 'claude'
  })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Base branch the new agent will be created from. Defaults to the project's
  // current branch; can be pointed at another agent's hydra/<id> branch to stack
  // agents on top of one another. `branches` is null until the list loads.
  const [branches, setBranches] = useState<RepositoryBranch[] | null>(null)
  const [baseBranch, setBaseBranch] = useState('')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [dragOver, setDragOver] = useState(false)
  // Index into the image-only attachment list while the lightbox is open; null
  // when closed.
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null)
  // Numbers generically-named pasted images (image.png, image.png, …) as
  // image1.png, image2.png, … so each can be referred to distinctly in the
  // prompt. Per project + layout (persisted via imageCounterKey) so the count
  // doesn't bleed across projects, and reset after a successful spawn.
  const imageCounterRef = useRef(0)
  const fileInputRef = useRef<HTMLInputElement>(null)
  // Mirrors `attachments` into a ref so the project-switch effect can stash the
  // outgoing project's attachments without depending on (and re-running for)
  // every attachment change.
  const attachmentsRef = useRef<Attachment[]>([])

  useEffect(() => {
    attachmentsRef.current = attachments
  }, [attachments])

  useEffect(() => {
    writeLocal(StorageKeys.defaultAgentType, agentType)
  }, [agentType])

  // Load the project's branches for the base-branch selector and default the
  // selection to the current branch. Re-runs (and resets) when the project
  // changes; ignores the result if the project switched mid-flight.
  useEffect(() => {
    if (!projectId) {
      setBranches(null)
      setBaseBranch('')
      return
    }
    let cancelled = false
    api.default.getRepositoryBranches(projectId)
      .then((res) => {
        if (cancelled) return
        setBranches(res.branches)
        setBaseBranch(res.current || res.branches[0]?.name || '')
      })
      .catch(() => {
        if (!cancelled) setBranches(null)
      })
    return () => { cancelled = true }
  }, [projectId])

  const textareaRef = useRef<HTMLTextAreaElement>(null)
  // The resizable element is the whole card (textarea + footer), so the drag
  // grip sits at the bottom-right of the entire box rather than just the
  // textarea. We persist/restore the card's height for compact mode.
  const cardRef = useRef<HTMLDivElement>(null)

  // Persist card height for compact mode
  useEffect(() => {
    if (!compact || !cardRef.current) return

    const card = cardRef.current
    const savedHeight = readLocal(StorageKeys.spawnHeight)
    if (savedHeight) {
      card.style.height = `${savedHeight}px`
    }

    let timer: ReturnType<typeof setTimeout>
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const height = (entry.target as HTMLElement).offsetHeight
        if (height > 0) {
          clearTimeout(timer)
          timer = setTimeout(() => {
            writeLocal(StorageKeys.spawnHeight, String(height))
          }, 200)
        }
      }
    })

    observer.observe(card)
    return () => {
      observer.disconnect()
      clearTimeout(timer)
    }
  }, [compact])

  // Custom drag-to-resize handle for the spawn card. We use a styled grab bar
  // (matching the sidebar width resizer) rather than the native textarea resize
  // grip, which looked awkward poking out of the card's rounded gradient corner.
  // Dragging sets the card height directly; the ResizeObserver above persists it
  // for the compact box.
  // Pointer events (not mouse) so the drag works with touch + pen too, e.g. on
  // mobile. `touch-none` on the handle keeps the browser from hijacking the
  // gesture for scrolling.
  function handleCardResizeStart(e: React.PointerEvent) {
    e.preventDefault()
    const card = cardRef.current
    if (!card) return
    const startY = e.clientY
    const startHeight = card.offsetHeight
    const min = compact ? 128 : 180
    document.body.style.cursor = 'ns-resize'
    document.body.style.userSelect = 'none'
    const onMove = (ev: PointerEvent) => {
      card.style.height = `${Math.max(min, startHeight + ev.clientY - startY)}px`
    }
    const onUp = () => {
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      document.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerup', onUp)
    }
    document.addEventListener('pointermove', onMove)
    document.addEventListener('pointerup', onUp)
  }

  // The grab bar rendered at the bottom of each spawn card.
  function renderResizeHandle() {
    return (
      <div
        onPointerDown={handleCardResizeStart}
        className="group shrink-0 h-2 -mt-1.5 flex items-center justify-center cursor-ns-resize touch-none"
        title="Drag to resize"
      >
        <div className="h-0.5 w-10 rounded-full bg-gray-200 dark:bg-gray-600 group-hover:bg-blue-400/70 group-active:bg-blue-500 transition-colors" />
      </div>
    )
  }

  useEffect(() => {
    if (!compact) textareaRef.current?.focus()
  }, [compact])

  // Persist the in-progress prompt as a per-project draft so it survives page
  // reloads and project switches. The compact (sidebar) and full-page boxes use
  // distinct keys so their drafts never bleed into one another.
  const draftKey = projectId ? promptDraftKey(projectId, compact) : null
  const scrollKey = projectId ? promptScrollKey(projectId, compact) : null

  // Load the saved draft on mount and whenever the project changes, clearing the
  // box when the new project has no draft, then restore that project's saved
  // scroll position. The scroll offset is restored in a rAF because the
  // textarea's scrollable range only exists after the setPrompt above commits
  // the new text to the DOM.
  useEffect(() => {
    if (!draftKey) {
      setPrompt('')
      return
    }
    setPrompt(readLocal(draftKey) ?? '')
    const saved = scrollKey ? Number(readLocal(scrollKey)) || 0 : 0
    const raf = requestAnimationFrame(() => {
      if (textareaRef.current) textareaRef.current.scrollTop = saved
    })
    return () => cancelAnimationFrame(raf)
  }, [draftKey, scrollKey])

  function handlePromptChange(value: string) {
    setPrompt(value)
    if (!draftKey) return
    writeLocal(draftKey, value || null)
  }

  // Persist the textarea's scroll offset so it travels with the draft when
  // switching projects (saved live on scroll; restored by the load effect above).
  function handlePromptScroll(e: React.UIEvent<HTMLTextAreaElement>) {
    if (scrollKey) writeLocal(scrollKey, String(e.currentTarget.scrollTop))
  }

  // Per-project attachments + image counter, swapped in/out as the project (or
  // layout) changes so each box keeps its own — just like the text draft. The
  // attachments live in an in-session module cache (their thumbnails are object
  // URLs that can't be persisted); the counter is mirrored to localStorage.
  const storeKey = projectId ? spawnDraftKey(projectId, compact) : null
  const counterKey = projectId ? imageCounterKey(projectId, compact) : null
  const prevStoreKeyRef = useRef<string | null>(null)

  useEffect(() => {
    const prev = prevStoreKeyRef.current
    if (prev === storeKey) return
    // Stash the outgoing project's attachments before loading the new one's.
    if (prev) saveAttachments(prev, attachmentsRef.current)
    if (storeKey) {
      setAttachments(loadAttachments(storeKey))
      imageCounterRef.current = Number(readLocal(counterKey!)) || 0
    } else {
      setAttachments([])
      imageCounterRef.current = 0
    }
    prevStoreKeyRef.current = storeKey
  }, [storeKey, counterKey])

  // Persist the current box's attachments to the cache on unmount (the
  // full-page form remounts when navigating between projects).
  useEffect(() => {
    return () => {
      const key = prevStoreKeyRef.current
      if (key) saveAttachments(key, attachmentsRef.current)
    }
  }, [])

  function handleIdChange(value: string) {
    setAgentId(slugify(value, 40, true))
    setIdManuallyEdited(true)
  }

  // Clipboard screenshots all arrive named "image.png", so a multi-image prompt
  // ends up with several indistinguishable attachments. Rename those generic
  // (or unnamed) images to image1.png, image2.png, … so the on-disk path — and
  // therefore the reference the user can type in the prompt — is unique. Files
  // with a real name (e.g. a dragged "diagram.png") keep it.
  function numberGenericImage(file: File): File {
    if (!isImageFile(file)) return file
    const stem = file.name.replace(/\.[^.]*$/, '')
    if (stem !== '' && stem.toLowerCase() !== 'image') return file
    const ext = (file.name.match(/\.([^.]+)$/)?.[1] || file.type.split('/')[1] || 'png').toLowerCase()
    const n = ++imageCounterRef.current
    if (counterKey) writeLocal(counterKey, String(imageCounterRef.current))
    return new File([file], `image${n}.${ext}`, { type: file.type, lastModified: file.lastModified })
  }

  // Upload each file, tracking it as an attachment chip. The uploaded path is
  // appended to the prompt on submit (and so wired through to the agent).
  function addFiles(rawFiles: File[]) {
    const files = rawFiles.map(numberGenericImage)
    for (const file of files) {
      const id = nextAttachmentId()
      const previewUrl = isImageFile(file) ? URL.createObjectURL(file) : undefined
      setAttachments((prev) => [...prev, { id, filename: file.name || 'pasted-image', path: null, previewUrl, size: file.size, uploading: true }])
      uploadFile(projectId, file)
        .then((res) => {
          setAttachments((prev) => prev.map((a) => (a.id === id ? { ...a, path: res.path, uploading: false } : a)))
        })
        .catch((err) => {
          setAttachments((prev) => prev.map((a) => (a.id === id ? { ...a, uploading: false, error: formatError(err) } : a)))
        })
    }
  }

  function removeAttachment(id: number) {
    setAttachments((prev) => {
      const found = prev.find((a) => a.id === id)
      if (found?.previewUrl) URL.revokeObjectURL(found.previewUrl)
      return prev.filter((a) => a.id !== id)
    })
  }

  function handlePaste(e: React.ClipboardEvent) {
    const files = extractFiles(e.clipboardData)
    if (files.length === 0) return
    e.preventDefault()
    addFiles(files)
  }

  function handleDrop(e: React.DragEvent) {
    const files = extractFiles(e.dataTransfer)
    setDragOver(false)
    if (files.length === 0) return
    e.preventDefault()
    addFiles(files)
  }

  function handleFileInput(e: React.ChangeEvent<HTMLInputElement>) {
    if (e.target.files) addFiles(Array.from(e.target.files))
    e.target.value = ''
  }

  const uploading = attachments.some((a) => a.uploading)
  const readyAttachments = attachments.filter((a) => a.path && !a.error)
  // Image attachments (those with a preview), in chip order — the lightbox
  // navigates this list, and each thumbnail opens its own index here.
  const imageAttachments = attachments.filter((a) => a.previewUrl)
  const lightboxImages = imageAttachments.map((a) => ({ url: a.previewUrl!, filename: a.filename, size: a.size }))
  const canSubmit = (!!prompt.trim() || readyAttachments.length > 0) && !uploading

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!canSubmit || loading) return
    setLoading(true)
    setError(null)
    try {
      // Append uploaded file paths so the agent receives them as part of the
      // task. They sit on their own lines below the typed prompt.
      const paths = readyAttachments.map((a) => a.path).join('\n')
      const base = prompt.trim()
      const finalPrompt = paths ? (base ? `${base}\n\n${paths}` : paths) : base
      const finalId = idManuallyEdited ? slugify(agentId) : ''
      const req: SpawnAgentRequest = {
        prompt: finalPrompt,
        agent_type: agentType,
        id: finalId || generateId(base) || generateId(readyAttachments[0]?.filename ?? '') || 'attachment',
        ...(baseBranch ? { base_branch: baseBranch } : {}),
      }
      const agent = await api.default.spawnAgent(projectId ?? '', req)
      setPrompt('')
      if (draftKey) writeLocal(draftKey, null)
      if (scrollKey) writeLocal(scrollKey, null)
      setAgentId('')
      setIdManuallyEdited(false)
      attachments.forEach((a) => a.previewUrl && URL.revokeObjectURL(a.previewUrl))
      setAttachments([])
      if (storeKey) saveAttachments(storeKey, [])
      setLightboxIndex(null)
      imageCounterRef.current = 0
      if (counterKey) writeLocal(counterKey, null)
      onSpawned?.(agent)
    } catch (err) {
      setError(formatError(err))
    } finally {
      setLoading(false)
    }
  }

  // Renders the attachment chips row (shared by both layout variants). Clicking
  // an image chip opens the lightbox at that image's index.
  function renderAttachments(size: 'sm' | 'md') {
    return (
      <AttachmentChips
        attachments={attachments}
        size={size}
        className={`px-3 ${size === 'sm' ? 'pb-1.5' : 'pb-2'}`}
        onRemove={removeAttachment}
        onOpenImage={(id) => setLightboxIndex(imageAttachments.findIndex((img) => img.id === id))}
      />
    )
  }

  // The base-branch picker, shown immediately left of the Spawn button. Hidden
  // until branches load (or if the project has none). In the narrow compact
  // footer it shrinks and truncates; on the full-page form it sizes to content.
  function renderBranchSelector(compactSel: boolean) {
    if (!branches || branches.length === 0) return null
    const selector = (
      <BranchSelector
        branches={branches}
        activeRef={baseBranch}
        isKnownBranch={branches.some((b) => b.name === baseBranch)}
        onSelect={setBaseBranch}
        title="Base branch to create the agent from (pick an agent branch to stack on it)"
        flexible={compactSel}
      />
    )
    if (compactSel) {
      return <div className="flex min-w-0 max-w-[8rem] shrink">{selector}</div>
    }
    return (
      <div className="flex items-center gap-1.5 shrink-0">
        <span className="hidden sm:inline text-xs text-gray-400 dark:text-gray-500">from</span>
        {selector}
      </div>
    )
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement | HTMLInputElement>) {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault()
      handleSubmit(e as unknown as React.FormEvent)
    }
  }

  const derivedIdPlaceholder = generateId(prompt) || 'auto-generated…'
  const submitHint = isMac ? '⌘↵ to spawn' : 'Ctrl+Enter to spawn'

  // Shared across both layout variants. The index can fall out of range if an
  // image is removed while open, so clamp it and close when there are none left.
  const lightbox =
    lightboxIndex !== null && lightboxImages.length > 0 ? (
      <ImageLightbox
        images={lightboxImages}
        index={Math.min(lightboxIndex, lightboxImages.length - 1)}
        onIndexChange={setLightboxIndex}
        onClose={() => setLightboxIndex(null)}
      />
    ) : null

  if (compact) {
    return (
      <>
      <form onSubmit={handleSubmit} className="px-3 py-3 border-b border-gray-100 dark:border-gray-700">
        <input ref={fileInputRef} type="file" multiple className="hidden" onChange={handleFileInput} />
        <div className={`relative rounded-xl p-[1.5px] transition-colors duration-200 ${disabled ? 'bg-gray-100 dark:bg-gray-700' : 'bg-gray-200 dark:bg-gray-600 focus-within:bg-gradient-to-br focus-within:from-blue-500 focus-within:via-indigo-500 focus-within:to-purple-600 focus-within:shadow-md focus-within:shadow-blue-500/20'}`}>
          <div ref={cardRef} className="rounded-[10px] bg-white dark:bg-gray-800 overflow-hidden flex flex-col min-h-[128px]">
            <HighlightedTextarea
              ref={textareaRef}
              value={prompt}
              onChange={(e) => handlePromptChange(e.target.value)}
              onKeyDown={handleKeyDown}
              onScroll={handlePromptScroll}
              onPaste={handlePaste}
              onDrop={handleDrop}
              onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
              onDragLeave={() => setDragOver(false)}
              placeholder={disabled ? 'Select a project first…' : 'Describe a task…'}
              rows={3}
              disabled={loading || disabled}
              wrapperClassName={`w-full flex-1 min-h-0 ${dragOver ? 'ring-2 ring-blue-400 rounded' : ''}`}
              textClassName="px-3 pt-2.5 pb-1 text-xs leading-relaxed placeholder-gray-400 dark:placeholder-gray-500 disabled:opacity-50"
            />
            {renderAttachments('sm')}
            <div className="flex items-center justify-between px-2 pb-2 gap-1.5 shrink-0">
              <div className="flex items-center gap-1 min-w-0 flex-1">
                <Tooltip content="Attach files" side="top">
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={loading || disabled}
                    className="p-0.5 rounded text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors cursor-pointer disabled:opacity-40 shrink-0"
                  >
                    <Paperclip className="w-3 h-3" />
                  </button>
                </Tooltip>
                <AgentTypePicker value={agentType} onChange={setAgentType} size="sm" />
                <input
                  type="text"
                  value={idManuallyEdited ? agentId : ''}
                  onChange={(e) => handleIdChange(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder={derivedIdPlaceholder}
                  className="min-w-0 flex-1 text-[10px] text-gray-500 dark:text-gray-400 bg-transparent font-mono focus:outline-none placeholder-gray-300 dark:placeholder-gray-600 truncate ml-1"
                />
              </div>
              {renderBranchSelector(true)}
              <button
                type="submit"
                disabled={!canSubmit || loading || disabled}
                className="relative overflow-hidden text-[10px] font-semibold px-2.5 py-1 rounded-lg text-white bg-gradient-to-r from-blue-600 to-purple-600 animate-gradient shadow-sm cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed transition-opacity hover:opacity-90 shrink-0"
              >
                {loading ? '…' : 'Spawn'}
              </button>
            </div>
            {renderResizeHandle()}
          </div>
        </div>
        {error && (
          <p className="mt-1.5 text-[10px] text-red-500 leading-snug">{error}</p>
        )}
      </form>
      {lightbox}
      </>
    )
  }

  // Full-page (empty state) variant
  return (
    <>
    <div className="flex-1 min-w-0 flex flex-col items-center justify-center p-4 sm:p-8">
      <div className="w-full max-w-4xl min-w-0">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-2xl bg-gradient-to-br from-blue-500 to-purple-600 shadow-lg shadow-blue-500/30 mb-4">
            <Zap className="w-6 h-6 text-white" />
          </div>
          <h2 className="text-2xl font-bold bg-gradient-to-r from-blue-600 via-indigo-600 to-purple-600 bg-clip-text text-transparent animate-gradient">
            Spawn an Agent
          </h2>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">Describe what you need — and consider it done.</p>
        </div>

        <form onSubmit={handleSubmit}>
          <input ref={fileInputRef} type="file" multiple className="hidden" onChange={handleFileInput} />
          {/* Gradient border card */}
          <div className="relative rounded-2xl p-[1.5px] bg-gradient-to-br from-blue-500 via-indigo-500 to-purple-600 animate-gradient shadow-2xl shadow-blue-500/20">
            <div ref={cardRef} className="rounded-[14px] bg-white dark:bg-gray-800 overflow-hidden flex flex-col min-h-[180px]">
              {/* Prompt textarea */}
              <HighlightedTextarea
                ref={textareaRef}
                value={prompt}
                onChange={(e) => handlePromptChange(e.target.value)}
                onKeyDown={handleKeyDown}
                onScroll={handlePromptScroll}
                onPaste={handlePaste}
                onDrop={handleDrop}
                onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
                onDragLeave={() => setDragOver(false)}
                placeholder="Describe what you need…"
                rows={6}
                disabled={loading}
                wrapperClassName={`w-full flex-1 min-h-0 ${dragOver ? 'ring-2 ring-blue-400 rounded' : ''}`}
                textClassName="px-4 pt-4 pb-2 text-sm leading-relaxed placeholder-gray-400 dark:placeholder-gray-500 disabled:opacity-50"
              />

              {renderAttachments('md')}

              {/* Footer bar — stacks the controls above the Spawn button on
                  narrow screens instead of overflowing the card */}
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between px-4 py-3 border-t border-gray-100 dark:border-gray-700 gap-3 shrink-0">
                <div className="flex items-center gap-2 min-w-0 flex-wrap sm:flex-1">
                  {/* Attach files */}
                  <Tooltip content="Attach files" side="top">
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      disabled={loading}
                      className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors cursor-pointer disabled:opacity-40 shrink-0"
                    >
                      <Paperclip className="w-4 h-4" />
                    </button>
                  </Tooltip>
                  {/* Agent type picker (icon trigger + named dropdown) */}
                  <AgentTypePicker value={agentType} onChange={setAgentType} />
                  {/* Divider */}
                  <span className="text-gray-200 dark:text-gray-600 text-sm shrink-0">|</span>
                  {/* ID field */}
                  <div className="flex items-center gap-1.5 min-w-0 flex-1">
                    <span className="text-xs text-gray-400 dark:text-gray-500 shrink-0">id:</span>
                    <input
                      type="text"
                      value={idManuallyEdited ? agentId : ''}
                      onChange={(e) => handleIdChange(e.target.value)}
                      onKeyDown={handleKeyDown}
                      placeholder={derivedIdPlaceholder}
                      className="flex-1 min-w-0 text-xs text-gray-600 dark:text-gray-300 font-mono bg-gray-50 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded-md px-2 py-0.5 focus:outline-none focus:border-blue-300 dark:focus:border-blue-500 focus:bg-white dark:focus:bg-gray-600 transition-colors placeholder-gray-300 dark:placeholder-gray-500"
                    />
                  </div>
                </div>
                <div className="flex items-center gap-3 shrink-0 self-end sm:self-auto">
                  {renderBranchSelector(false)}
                  <span className="hidden sm:inline text-xs text-gray-400 dark:text-gray-500">{submitHint}</span>
                  <button
                    type="submit"
                    disabled={!canSubmit || loading}
                    className="relative overflow-hidden flex items-center gap-2 px-5 py-2 rounded-xl text-sm font-semibold text-white bg-gradient-to-r from-blue-600 via-indigo-600 to-purple-600 animate-gradient shadow-md shadow-blue-500/30 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed transition-all hover:shadow-lg hover:shadow-blue-500/40 hover:scale-[1.02] active:scale-[0.98]"
                  >
                    {loading ? (
                      <>
                        <LoaderCircle className="w-3.5 h-3.5 animate-spin" />
                        Spawning…
                      </>
                    ) : (
                      <>
                        <Zap className="w-3.5 h-3.5" />
                        Spawn Agent
                      </>
                    )}
                  </button>
                </div>
              </div>
              {renderResizeHandle()}
            </div>
          </div>

          {error && (
            <div className="mt-3 px-4 py-2.5 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-xl">
              <p className="text-xs text-red-600 dark:text-red-400">{error}</p>
            </div>
          )}
        </form>
      </div>
    </div>
    {lightbox}
    </>
  )
}
