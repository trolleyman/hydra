import type { Editor, JSONContent } from '@tiptap/core'
import { EditorContent, useEditor } from '@tiptap/react'
import { BubbleMenu } from '@tiptap/react/menus'
import { TextSelection } from '@tiptap/pm/state'
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { createRichEditorExtensions, parseRichMarkdown, serializeRichMarkdown } from './RichEditorCore'
import type { AttachmentRegistry } from './AttachmentRegistry'
import { registerMountedEditor } from './mountedEditors'
import { insertReference, type ComposerReference, type ReferenceKind } from './Reference'
import { handleTableKeyDown, isTableSelection } from './Table'

export interface MarkdownComposerHandle {
  editor: Editor | null
  focus: (position?: 'start' | 'end' | number) => void
}

export interface MarkdownComposerKeyContext {
  editor: Editor
  markdown: string
  empty: boolean
}

export interface MarkdownComposerProps {
  value: string
  onChange: (markdown: string) => void
  initialDocument?: JSONContent
  onDocumentChange?: (document: JSONContent) => void
  onEditor?: (editor: Editor | null) => void
  onSelectionChange?: (editor: Editor) => void
  onKeyDown?: (event: KeyboardEvent, context: MarkdownComposerKeyContext) => boolean | void
  onPaste?: (event: ClipboardEvent, editor: Editor) => boolean | void
  onDrop?: (event: DragEvent, editor: Editor) => boolean | void
  editable?: boolean
  autoFocus?: boolean
  placeholder?: string
  ariaLabel?: string
  dataDesktopImagePaste?: boolean
  spellCheck?: boolean
  className?: string
  attachmentRegistry?: AttachmentRegistry
  onOpenAttachment?: (id: string, origin: Element) => void
  references?: ComposerReference[]
  onRequestFiles?: () => void
}

function safeLinkHref(value: string): string | null {
  const href = value.trim()
  if (!href) return null
  if (/^(https?:|mailto:|#|\/)/i.test(href)) return href
  if (!/^[a-z][a-z0-9+.-]*:/i.test(href)) return `https://${href}`
  return null
}

type DiscoveryItem = { id: string; label: string; detail?: string; run: (editor: Editor) => void }
type DiscoveryState = { kind: 'slash' | 'reference'; items: DiscoveryItem[]; selected: number }

const REFERENCE_KINDS: ReferenceKind[] = ['file', 'branch', 'commit', 'agent']

function discoveryState(editor: Editor, references: ComposerReference[], onRequestFiles?: () => void): DiscoveryState | null {
  const { $from } = editor.state.selection
  if (!editor.state.selection.empty || !$from.parent.isTextblock) return null
  const before = $from.parent.textBetween(0, $from.parentOffset, undefined, '\ufffc')
  const blockStart = $from.start()

  const slash = before.match(/^\/([^\s]*)$/)
  if (slash) {
    const query = slash[1].toLowerCase()
    const range = { from: blockStart, to: $from.pos }
    const commands: Array<[string, string, (target: Editor) => void]> = [
      ['text', 'Text', (target) => { target.chain().focus().deleteRange(range).setParagraph().run() }],
      ['heading', 'Heading', (target) => { target.chain().focus().deleteRange(range).toggleHeading({ level: 2 }).run() }],
      ['list', 'Bullet list', (target) => { target.chain().focus().deleteRange(range).toggleBulletList().run() }],
      ['task', 'Task list', (target) => { target.chain().focus().deleteRange(range).toggleTaskList().run() }],
      ['quote', 'Quote', (target) => { target.chain().focus().deleteRange(range).toggleBlockquote().run() }],
      ['code', 'Code block', (target) => { target.chain().focus().deleteRange(range).toggleCodeBlock().run() }],
      ['table', 'Table', (target) => { target.chain().focus().deleteRange(range).insertTable({ rows: 2, cols: 2, withHeaderRow: true }).run() }],
      ['attach', 'Attach file', (target) => { target.chain().focus().deleteRange(range).run(); onRequestFiles?.() }],
    ]
    const items = commands
      .filter(([id, label]) => !query || id.startsWith(query) || label.toLowerCase().includes(query))
      .filter(([id]) => id !== 'attach' || onRequestFiles)
      .map(([id, label, run]) => ({ id: `slash-${id}`, label, run }))
    return items.length ? { kind: 'slash', items, selected: 0 } : null
  }

  const reference = before.match(/(?:^|\s)@(file|branch|commit|agent):([^\s]*)$/)
  if (reference) {
    const kind = reference[1] as ReferenceKind
    const query = reference[2]
    const triggerLength = reference[0].trimStart().length
    const range = { from: $from.pos - triggerLength, to: $from.pos }
    const matches = references
      .filter((candidate) => candidate.kind === kind && (!query || candidate.value.toLowerCase().includes(query.toLowerCase()) || candidate.label?.toLowerCase().includes(query.toLowerCase())))
      .slice(0, 8)
    if (query && !matches.some((candidate) => candidate.value === query)) {
      if (kind === 'file' || kind === 'commit') matches.unshift({ kind, value: query })
      else matches.push({ kind, value: query })
    }
    const items = matches.map((candidate) => ({
      id: `${kind}-${candidate.value}`,
      label: candidate.label ?? candidate.value,
      detail: kind,
      run: (target: Editor) => { insertReference(target, candidate, range); target.commands.focus() },
    }))
    return items.length ? { kind: 'reference', items, selected: 0 } : null
  }

  const bareReference = before.match(/(?:^|\s)@([a-z]*)$/)
  if (bareReference) {
    const query = bareReference[1]
    const range = { from: $from.pos - query.length - 1, to: $from.pos }
    const items = REFERENCE_KINDS
      .filter((kind) => kind.startsWith(query))
      .map((kind) => ({
        id: `reference-kind-${kind}`,
        label: `${kind} reference`,
        detail: `@${kind}:`,
        run: (target: Editor) => { target.chain().focus().insertContentAt(range, `@${kind}:`).run() },
      }))
    return items.length ? { kind: 'reference', items, selected: 0 } : null
  }
  return null
}

/**
 * Controlled Markdown adapter around Hydra's rich editor schema.
 *
 * Markdown is deliberately the public value: chat drafts, submission and
 * callers do not need to know about Tiptap or ProseMirror documents. The
 * editor keeps its live document and selection internally, only accepting an
 * external value when it actually differs from its own serialization.
 */
export const MarkdownComposer = forwardRef<MarkdownComposerHandle, MarkdownComposerProps>(function MarkdownComposer({
  value,
  onChange,
  initialDocument,
  onDocumentChange,
  onEditor,
  onSelectionChange,
  onKeyDown,
  onPaste,
  onDrop,
  editable = true,
  autoFocus = false,
  placeholder,
  ariaLabel = 'Message',
  dataDesktopImagePaste = false,
  spellCheck = false,
  className = '',
  attachmentRegistry,
  onOpenAttachment,
  references = [],
  onRequestFiles,
}, ref) {
  const onChangeRef = useRef(onChange)
  const onEditorRef = useRef(onEditor)
  const onKeyDownRef = useRef(onKeyDown)
  const onPasteRef = useRef(onPaste)
  const onDropRef = useRef(onDrop)
  const onOpenAttachmentRef = useRef(onOpenAttachment)
  const onSelectionChangeRef = useRef(onSelectionChange)
  const onDocumentChangeRef = useRef(onDocumentChange)
  const literalPasteRef = useRef(false)
  const pendingUpdateRef = useRef<{ document: JSONContent; markdown: string } | null>(null)
  const updateQueuedRef = useRef(false)
  // React may render an earlier controlled-value echo after the editor has
  // already produced a newer transaction (fast typing and IME are the common
  // cases). Remember self-emitted values so those echoes cannot roll the live
  // document back. Values not in this bounded queue are genuinely external.
  const emittedValuesRef = useRef<string[]>([])
  const [announcement, setAnnouncement] = useState('')
  const [linkOpen, setLinkOpen] = useState(false)
  const [linkHref, setLinkHref] = useState('')
  const [discovery, setDiscovery] = useState<DiscoveryState | null>(null)
  const discoveryRef = useRef<DiscoveryState | null>(null)
  const referencesRef = useRef(references)
  const onRequestFilesRef = useRef(onRequestFiles)
  discoveryRef.current = discovery
  referencesRef.current = references
  onRequestFilesRef.current = onRequestFiles
  onChangeRef.current = onChange
  onEditorRef.current = onEditor
  onKeyDownRef.current = onKeyDown
  onPasteRef.current = onPaste
  onDropRef.current = onDrop
  onOpenAttachmentRef.current = onOpenAttachment
  onSelectionChangeRef.current = onSelectionChange
  onDocumentChangeRef.current = onDocumentChange

  const restoredDocument = initialDocument && serializeRichMarkdown(initialDocument) === value
    ? initialDocument
    : undefined

  const editor: Editor | null = useEditor({
    extensions: createRichEditorExtensions(
      attachmentRegistry,
      true,
      (id, origin) => onOpenAttachmentRef.current?.(id, origin),
    ),
    content: restoredDocument ?? parseRichMarkdown(value),
    contentType: 'json',
    immediatelyRender: false,
    injectCSS: false,
    editable,
    editorProps: {
      attributes: {
        class: `rich-text-surface outline-none ${className}`.trim(),
        'aria-label': ariaLabel,
        role: 'textbox',
        'aria-multiline': 'true',
        spellcheck: String(spellCheck),
        ...(dataDesktopImagePaste ? { 'data-desktop-image-paste': '' } : {}),
        ...(placeholder ? { 'data-placeholder': placeholder } : {}),
      },
      handleKeyDown: (_view, event): boolean => {
        const activeDiscovery = discoveryRef.current
        if (activeDiscovery) {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            const direction = event.key === 'ArrowDown' ? 1 : -1
            setDiscovery((current) => current && ({ ...current, selected: (current.selected + direction + current.items.length) % current.items.length }))
            return true
          }
          if (event.key === 'Enter' || event.key === 'Tab') {
            event.preventDefault()
            activeDiscovery.items[activeDiscovery.selected]?.run(editor!)
            setDiscovery(null)
            return true
          }
          if (event.key === 'Escape') {
            event.preventDefault()
            setDiscovery(null)
            return true
          }
        }
        if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'v') {
          literalPasteRef.current = true
          setTimeout(() => { literalPasteRef.current = false }, 0)
          return false
        }
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
          event.preventDefault()
          setLinkHref(String(editor?.getAttributes('link').href ?? ''))
          setLinkOpen(true)
          return true
        }
        if (editor
          && event.key === 'Enter'
          && event.shiftKey
          && editor.state.selection.$from.parent.type.name === 'codeBlock') {
          event.preventDefault()
          editor.commands.insertContent('\n')
          return true
        }
        if (editor && isTableSelection(editor)) {
          // A host that owns bare Enter (chat sends, for example) keeps it.
          // Shift+Enter always performs table navigation; otherwise the table
          // gets Enter only when the host declines it.
          if (event.key === 'Enter' && !event.shiftKey && onKeyDownRef.current) {
            const markdown = serializeRichMarkdown(editor.getJSON())
            if (onKeyDownRef.current(event, { editor, markdown, empty: markdown.trim() === '' }) === true) return true
          }
          if (handleTableKeyDown(editor, event)) return true
          if (event.key === 'Enter' && !event.shiftKey && onKeyDownRef.current) return false
        }
        if (!onKeyDownRef.current || !editor) return false
        const markdown = serializeRichMarkdown(editor.getJSON())
        return onKeyDownRef.current(event, { editor, markdown, empty: markdown.trim() === '' }) === true
      },
      handlePaste: (_view, event): boolean => {
        if (!editor) return false
        if (literalPasteRef.current) {
          literalPasteRef.current = false
          event.preventDefault()
          return editor.commands.insertContent({
            type: 'text',
            text: event.clipboardData?.getData('text/plain') ?? '',
          })
        }
        return onPasteRef.current?.(event, editor) === true
      },
      handleDOMEvents: {
        // A composer is normally taller than its last text line. Clicking that
        // blank area should focus the document at its end, not leave the caret
        // wherever it happened to be before.
        mousedown: (view, event): boolean => {
          if (event.target !== view.dom || event.button !== 0) return false
          view.dispatch(view.state.tr.setSelection(TextSelection.atEnd(view.state.doc)).scrollIntoView())
          view.focus()
          event.preventDefault()
          return true
        },
        // File drops must be intercepted before ProseMirror's built-in drop
        // handler asks the document for a text insertion coordinate. WebKitGTK
        // file drags can otherwise insert their local URI as prose, and jsdom
        // has no elementFromPoint for that coordinate lookup.
        drop: (_view, event): boolean => (
          editor ? onDropRef.current?.(event, editor) === true : false
        ),
      },
    },
    onUpdate: ({ editor: updated }) => {
      const document = updated.getJSON()
      const markdown = serializeRichMarkdown(document)
      emittedValuesRef.current.push(markdown)
      if (emittedValuesRef.current.length > 32) emittedValuesRef.current.shift()
      // Let ProseMirror finish appended transactions (notably the inline-code
      // boundary selection) before a controlled parent render can run. Each DOM
      // input event still flushes before the next event, while synchronous
      // transactions are coalesced to their final document.
      pendingUpdateRef.current = { document, markdown }
      if (!updateQueuedRef.current) {
        updateQueuedRef.current = true
        queueMicrotask(() => {
          updateQueuedRef.current = false
          const pending = pendingUpdateRef.current
          pendingUpdateRef.current = null
          if (!pending) return
          onDocumentChangeRef.current?.(pending.document)
          onChangeRef.current(pending.markdown)
          setDiscovery(discoveryState(updated, referencesRef.current, onRequestFilesRef.current))
        })
      }
    },
    onSelectionUpdate: ({ editor: updated }) => {
      // Do not render a menu before a same-transaction controlled value has
      // reached the parent; that render could feed the previous Markdown value
      // back into the editor and erase the edit that opened the menu.
      setTimeout(() => setDiscovery(discoveryState(updated, referencesRef.current, onRequestFilesRef.current)), 0)
      onSelectionChangeRef.current?.(updated)
    },
  })

  useEffect(() => {
    if (autoFocus && editable) editor?.commands.focus('end')
  }, [autoFocus, editable, editor])

  useImperativeHandle(ref, () => ({
    editor,
    focus: (position = 'end') => { editor?.commands.focus(position) },
  }), [editor])

  useEffect(() => {
    onEditorRef.current?.(editor)
    const unregister = editor ? registerMountedEditor(editor) : undefined
    return () => {
      unregister?.()
      onEditorRef.current?.(null)
    }
  }, [editor])

  useEffect(() => {
    if (!editor) return
    editor.setEditable(editable)
  }, [editable, editor])

  useEffect(() => {
    if (!editor || !attachmentRegistry) return
    return attachmentRegistry.bind(editor)
  }, [attachmentRegistry, editor])

  useEffect(() => {
    if (!editor) return
    // A host-side attachment update can render the controlled value again in
    // the same turn as a local editor transaction. The queued onChange below
    // has not delivered that transaction yet, so the older prop is not an
    // external edit and must not roll the document back.
    if (pendingUpdateRef.current) return
    const echoed = emittedValuesRef.current.indexOf(value)
    if (echoed >= 0) {
      emittedValuesRef.current.splice(0, echoed + 1)
      return
    }
    const current = serializeRichMarkdown(editor.getJSON())
    if (current === value) return
    editor.commands.setContent(parseRichMarkdown(value), { contentType: 'json', emitUpdate: false })
    onDocumentChangeRef.current?.(editor.getJSON())
  }, [editor, value])

  useEffect(() => {
    if (!editor) return
    const announce = (event: Event) => {
      const message = (event as CustomEvent<unknown>).detail
      if (typeof message !== 'string') return
      setAnnouncement('')
      requestAnimationFrame(() => setAnnouncement(message))
    }
    const dom = editor.view.dom
    dom.addEventListener('rich-table-announcement', announce)
    return () => dom.removeEventListener('rich-table-announcement', announce)
  }, [editor])

  return (
    <div className="relative h-full min-h-0">
      <EditorContent editor={editor} />
      {editor && editable && (
        <BubbleMenu
          editor={editor}
          shouldShow={({ editor: current }) => linkOpen || current.isActive('link')}
          options={{ placement: 'top', offset: 8 }}
          className="flex items-center gap-1 rounded-lg border border-gray-200 bg-white p-1 shadow-xl dark:border-white/10 dark:bg-gray-800"
        >
          {linkOpen ? (
            <form
              className="flex items-center gap-1"
              onSubmit={(event) => {
                event.preventDefault()
                const href = safeLinkHref(linkHref)
                if (!href) return
                editor.chain().focus().extendMarkRange('link').setLink({ href }).run()
                setLinkOpen(false)
              }}
            >
              <input
                autoFocus
                aria-label="Link URL"
                value={linkHref}
                onChange={(event) => setLinkHref(event.target.value)}
                placeholder="https://example.com"
                className="h-7 w-56 rounded border border-gray-200 bg-white px-2 text-xs outline-none focus:border-blue-400 dark:border-gray-600 dark:bg-gray-900"
              />
              <button type="submit" className="h-7 rounded px-2 text-xs text-blue-700 hover:bg-blue-50 dark:text-blue-300 dark:hover:bg-blue-500/10">Apply</button>
              {editor.isActive('link') && (
                <button
                  type="button"
                  onClick={() => { editor.chain().focus().extendMarkRange('link').unsetLink().run(); setLinkOpen(false) }}
                  className="h-7 rounded px-2 text-xs text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-white/[0.06]"
                >
                  Remove
                </button>
              )}
            </form>
          ) : (
            <>
              <button
                type="button"
                onClick={() => { setLinkHref(String(editor.getAttributes('link').href ?? '')); setLinkOpen(true) }}
                className="h-7 rounded px-2 text-xs text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-white/[0.06]"
              >
                Edit link
              </button>
              <a
                href={String(editor.getAttributes('link').href ?? '')}
                target="_blank"
                rel="noreferrer"
                className="h-7 rounded px-2 text-xs leading-7 text-blue-700 hover:bg-blue-50 dark:text-blue-300 dark:hover:bg-blue-500/10"
              >
                Open
              </a>
              <button
                type="button"
                onClick={() => editor.chain().focus().extendMarkRange('link').unsetLink().run()}
                className="h-7 rounded px-2 text-xs text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-white/[0.06]"
              >
                Remove
              </button>
            </>
          )}
        </BubbleMenu>
      )}
      {discovery && (
        <div className="absolute bottom-1 left-2 z-30 max-h-64 min-w-52 overflow-y-auto rounded-lg border border-gray-200 bg-white p-1 shadow-xl dark:border-white/10 dark:bg-gray-800" role="listbox" aria-label={discovery.kind === 'slash' ? 'Block commands' : 'References'}>
          {discovery.items.map((item, index) => (
            <button
              key={item.id}
              type="button"
              role="option"
              aria-selected={index === discovery.selected}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => { item.run(editor!); setDiscovery(null) }}
              className={`flex w-full items-center justify-between gap-4 rounded-md px-2.5 py-2 text-left text-xs ${index === discovery.selected ? 'bg-blue-50 text-blue-700 dark:bg-blue-500/15 dark:text-blue-300' : 'text-gray-700 hover:bg-gray-50 dark:text-gray-200 dark:hover:bg-white/[0.05]'}`}
            >
              <span className="optical-center">{item.label}</span>
              {item.detail && <span className="font-mono text-3xs text-gray-400">{item.detail}</span>}
            </button>
          ))}
        </div>
      )}
      <span className="sr-only" role="status" aria-live="polite">{announcement}</span>
    </div>
  )
})
