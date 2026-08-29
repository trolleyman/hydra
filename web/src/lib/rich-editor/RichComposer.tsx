import type { Editor } from '@tiptap/core'
import { EditorContent, useEditor } from '@tiptap/react'
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import { richEditorExtensions, serializeRichMarkdown } from './RichEditorCore'

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
  onEditor?: (editor: Editor | null) => void
  onSelectionChange?: (editor: Editor) => void
  onKeyDown?: (event: KeyboardEvent, context: RichComposerKeyContext) => boolean | void
  onPaste?: (event: ClipboardEvent, editor: Editor) => boolean | void
  editable?: boolean
  placeholder?: string
  ariaLabel?: string
  className?: string
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
  onEditor,
  onSelectionChange,
  onKeyDown,
  onPaste,
  editable = true,
  placeholder,
  ariaLabel = 'Message',
  className = '',
}, ref) {
  const onChangeRef = useRef(onChange)
  const onEditorRef = useRef(onEditor)
  const onKeyDownRef = useRef(onKeyDown)
  const onPasteRef = useRef(onPaste)
  const onSelectionChangeRef = useRef(onSelectionChange)
  onChangeRef.current = onChange
  onEditorRef.current = onEditor
  onKeyDownRef.current = onKeyDown
  onPasteRef.current = onPaste
  onSelectionChangeRef.current = onSelectionChange

  const editor: Editor | null = useEditor({
    extensions: richEditorExtensions,
    content: value,
    contentType: 'markdown',
    immediatelyRender: false,
    injectCSS: false,
    editable,
    editorProps: {
      attributes: {
        class: `rich-text-surface outline-none ${className}`.trim(),
        'aria-label': ariaLabel,
        ...(placeholder ? { 'data-placeholder': placeholder } : {}),
      },
      handleKeyDown: (_view, event): boolean => {
        if (!onKeyDownRef.current || !editor) return false
        const markdown = serializeRichMarkdown(editor.getJSON())
        return onKeyDownRef.current(event, { editor, markdown, empty: markdown.trim() === '' }) === true
      },
      handlePaste: (_view, event): boolean => !!editor && onPasteRef.current?.(event, editor) === true,
    },
    onUpdate: ({ editor: updated }) => onChangeRef.current(serializeRichMarkdown(updated.getJSON())),
    onSelectionUpdate: ({ editor: updated }) => onSelectionChangeRef.current?.(updated),
  })

  useImperativeHandle(ref, () => ({
    editor,
    focus: (position = 'end') => { editor?.commands.focus(position) },
  }), [editor])

  useEffect(() => {
    onEditorRef.current?.(editor)
    return () => onEditorRef.current?.(null)
  }, [editor])

  useEffect(() => {
    if (!editor) return
    editor.setEditable(editable)
  }, [editable, editor])

  useEffect(() => {
    if (!editor) return
    const current = serializeRichMarkdown(editor.getJSON())
    if (current === value) return
    editor.commands.setContent(value, { contentType: 'markdown', emitUpdate: false })
  }, [editor, value])

  return <EditorContent editor={editor} />
})
