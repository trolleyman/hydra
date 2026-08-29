import type { Editor, JSONContent } from '@tiptap/core'
import { EditorContent, useEditor } from '@tiptap/react'
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import { createRichEditorExtensions, serializeRichMarkdown } from './RichEditorCore'
import type { AttachmentRegistry } from './AttachmentRegistry'
import { registerMountedEditor } from './mountedEditors'

export interface RichComposerHandle {
  editor: Editor | null
  focus: (position?: 'start' | 'end' | number) => void
}

export interface RichComposerKeyContext {
  editor: Editor
  markdown: string
  empty: boolean
}

export interface RichComposerProps {
  value: string
  onChange: (markdown: string) => void
  initialDocument?: JSONContent
  onDocumentChange?: (document: JSONContent) => void
  onEditor?: (editor: Editor | null) => void
  onSelectionChange?: (editor: Editor) => void
  onKeyDown?: (event: KeyboardEvent, context: RichComposerKeyContext) => boolean | void
  onPaste?: (event: ClipboardEvent, editor: Editor) => boolean | void
  editable?: boolean
  placeholder?: string
  ariaLabel?: string
  spellCheck?: boolean
  className?: string
  attachmentRegistry?: AttachmentRegistry
}

/**
 * Controlled Markdown adapter around Hydra's rich editor schema.
 *
 * Markdown is deliberately the public value: chat drafts, submission and
 * callers do not need to know about Tiptap or ProseMirror documents. The
 * editor keeps its live document and selection internally, only accepting an
 * external value when it actually differs from its own serialization.
 */
export const RichComposer = forwardRef<RichComposerHandle, RichComposerProps>(function RichComposer({
  value,
  onChange,
  initialDocument,
  onDocumentChange,
  onEditor,
  onSelectionChange,
  onKeyDown,
  onPaste,
  editable = true,
  placeholder,
  ariaLabel = 'Message',
  spellCheck = false,
  className = '',
  attachmentRegistry,
}, ref) {
  const onChangeRef = useRef(onChange)
  const onEditorRef = useRef(onEditor)
  const onKeyDownRef = useRef(onKeyDown)
  const onPasteRef = useRef(onPaste)
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
  onChangeRef.current = onChange
  onEditorRef.current = onEditor
  onKeyDownRef.current = onKeyDown
  onPasteRef.current = onPaste
  onSelectionChangeRef.current = onSelectionChange
  onDocumentChangeRef.current = onDocumentChange

  const restoredDocument = initialDocument && serializeRichMarkdown(initialDocument) === value
    ? initialDocument
    : undefined

  const editor: Editor | null = useEditor({
    extensions: createRichEditorExtensions(attachmentRegistry),
    content: restoredDocument ?? value,
    contentType: restoredDocument ? 'json' : 'markdown',
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
        ...(placeholder ? { 'data-placeholder': placeholder } : {}),
      },
      handleKeyDown: (_view, event): boolean => {
        if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'v') {
          literalPasteRef.current = true
          setTimeout(() => { literalPasteRef.current = false }, 0)
          return false
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
        })
      }
    },
    onSelectionUpdate: ({ editor: updated }) => onSelectionChangeRef.current?.(updated),
  })

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
    const echoed = emittedValuesRef.current.indexOf(value)
    if (echoed >= 0) {
      emittedValuesRef.current.splice(0, echoed + 1)
      return
    }
    const current = serializeRichMarkdown(editor.getJSON())
    if (current === value) return
    editor.commands.setContent(value, { contentType: 'markdown', emitUpdate: false })
    onDocumentChangeRef.current?.(editor.getJSON())
  }, [editor, value])

  return <EditorContent editor={editor} />
})
