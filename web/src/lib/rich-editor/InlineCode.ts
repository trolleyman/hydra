import { Extension, Node, type Editor, type Range } from '@tiptap/core'
import { closeHistory } from '@tiptap/pm/history'
import { Plugin, TextSelection, type EditorState, type Transaction } from '@tiptap/pm/state'
import type { ResolvedPos } from '@tiptap/pm/model'
import { Decoration, DecorationSet } from '@tiptap/pm/view'

export const INLINE_CODE_NAME = 'inlineCode'

// InlineCode is deliberately a content-bearing inline node, not a code mark.
// Its opening/closing node tokens give the selection model separate positions
// before, inside-start, inside-end and after the capsule. The browser spike is
// the gate for whether those distinctions survive DOM selection in practice.
export const InlineCode = Node.create({
  name: INLINE_CODE_NAME,
  group: 'inline',
  inline: true,
  content: 'text*',
  marks: '',
  selectable: true,
  defining: true,

  parseHTML() {
    return [{ tag: 'code[data-inline-code]' }]
  },

  renderHTML() {
    return ['code', { 'data-inline-code': '' }, 0]
  },

  markdownTokenName: 'codespan',

  parseMarkdown(token) {
    return {
      type: INLINE_CODE_NAME,
      content: token.text ? [{ type: 'text', text: token.text }] : [],
    }
  },

  renderMarkdown(node) {
    return serializeInlineCode(node.content?.map((child) => child.text ?? '').join('') ?? '')
  },
})

// CommonMark code spans use a delimiter longer than any backtick run in the
// payload. Padding protects leading/trailing backticks and spaces while parsing
// back to the exact inline-code text.
export function serializeInlineCode(value: string): string {
  const longestRun = Math.max(0, ...[...value.matchAll(/`+/g)].map((match) => match[0].length))
  const delimiter = '`'.repeat(longestRun + 1)
  const needsPadding = value.startsWith('`') || value.endsWith('`')
    || (value.startsWith(' ') && value.endsWith(' ') && value.trim() !== '')
  const body = needsPadding ? ` ${value} ` : value
  return `${delimiter}${body}${delimiter}`
}

function inlineCodeDepth(state: EditorState): number {
  return inlineCodeDepthAt(state.selection.$from)
}

function inlineCodeDepthAt($pos: ResolvedPos): number {
  for (let depth = $pos.depth; depth > 0; depth--) {
    if ($pos.node(depth).type.name === INLINE_CODE_NAME) return depth
  }
  return -1
}

function setCaret(tr: Transaction, pos: number): Transaction {
  return tr.setSelection(TextSelection.create(tr.doc, pos)).scrollIntoView()
}

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

function graphemeBoundaries(value: string): number[] {
  return [...graphemeSegmenter.segment(value)].map((part) => part.index).concat(value.length)
}

function nextGrapheme(value: string, offset: number): number {
  return graphemeBoundaries(value).find((boundary) => boundary > offset) ?? value.length
}

function previousGrapheme(value: string, offset: number): number {
  const boundaries = graphemeBoundaries(value)
  for (let i = boundaries.length - 1; i >= 0; i--) {
    if (boundaries[i] < offset) return boundaries[i]
  }
  return 0
}

function unwrapInlineCode(editor: Editor, from: number, to: number, caret: number): boolean {
  const node = editor.state.doc.nodeAt(from)
  if (!node || node.type.name !== INLINE_CODE_NAME) return false
  const text = node.textContent
  const tr = editor.state.tr.replaceWith(from, to, text ? editor.state.schema.text(text) : [])
  editor.view.dispatch(setCaret(tr, caret))
  return true
}

function insertInlineCode(editor: Editor, range: Range): boolean {
  const selected = editor.state.doc.textBetween(range.from, range.to, '\n')
  if (selected.includes('\n')) return false
  const node = editor.state.schema.nodes[INLINE_CODE_NAME]
  if (!node) return false
  const content = selected ? editor.state.schema.text(selected) : undefined
  const code = node.create(null, content)
  const tr = editor.state.tr.replaceRangeWith(range.from, range.to, code)
  const start = range.from + 1
  tr.setSelection(selected
    ? TextSelection.create(tr.doc, start, start + selected.length)
    : TextSelection.create(tr.doc, start))
  editor.view.dispatch(tr.scrollIntoView())
  // The pair insertion and the text typed into it are separate user concepts:
  // first undo clears the typed run, second undo removes the empty capsule.
  editor.view.dispatch(closeHistory(editor.state.tr))
  return true
}

function backtick(editor: Editor): boolean {
  const { state } = editor
  const { selection } = state
  const depth = inlineCodeDepth(state)
  if (depth >= 0) {
    editor.view.dispatch(setCaret(state.tr, selection.$from.after(depth)))
    return true
  }
  // Three consecutive backticks should become the block construct people
  // expect. After the first key inserts an empty capsule and the second exits
  // it, the third arrives immediately after that empty node. Only upgrade when
  // it is the paragraph's sole content, so prose followed by an empty inline
  // capsule keeps ordinary inline-code semantics.
  const { $from } = selection
  const before = $from.nodeBefore
  if (selection.empty
    && before?.type.name === INLINE_CODE_NAME
    && before.content.size === 0
    && $from.parent.type.name === 'paragraph'
    && $from.parent.childCount === 1) {
    const codeBlock = state.schema.nodes.codeBlock
    if (codeBlock) {
      const paragraphDepth = $from.depth
      const from = $from.before(paragraphDepth)
      const tr = state.tr.replaceWith(from, $from.after(paragraphDepth), codeBlock.create())
      editor.view.dispatch(setCaret(tr, from + 1))
      return true
    }
  }
  return insertInlineCode(editor, { from: selection.from, to: selection.to })
}

function codeArrowTarget(state: EditorState, pos: number, direction: -1 | 1): number | null {
  const $pos = state.doc.resolve(pos)
  const depth = inlineCodeDepthAt($pos)
  if (depth >= 0) {
    if (direction > 0) {
      if ($pos.parentOffset === $pos.parent.content.size) return $pos.after(depth)
      const next = nextGrapheme($pos.parent.textContent, $pos.parentOffset)
      return $pos.start(depth) + next
    }
    if ($pos.parentOffset === 0) return $pos.before(depth)
    const previous = previousGrapheme($pos.parent.textContent, $pos.parentOffset)
    return $pos.start(depth) + previous
  }
  if (direction > 0 && $pos.nodeAfter?.type.name === INLINE_CODE_NAME) return pos + 1
  if (direction < 0 && $pos.nodeBefore?.type.name === INLINE_CODE_NAME) return pos - 1
  return null
}

function arrowRight(editor: Editor): boolean {
  const { state } = editor
  if (!state.selection.empty) return false
  const target = codeArrowTarget(state, state.selection.head, 1)
  if (target == null) return false
  editor.view.dispatch(setCaret(state.tr, target))
  return true
}

function arrowLeft(editor: Editor): boolean {
  const { state } = editor
  if (!state.selection.empty) return false
  const target = codeArrowTarget(state, state.selection.head, -1)
  if (target == null) return false
  editor.view.dispatch(setCaret(state.tr, target))
  return true
}

function extendSelection(editor: Editor, direction: -1 | 1): boolean {
  const { state } = editor
  const target = codeArrowTarget(state, state.selection.head, direction)
  if (target == null) return false
  const tr = state.tr.setSelection(TextSelection.create(state.doc, state.selection.anchor, target)).scrollIntoView()
  editor.view.dispatch(tr)
  return true
}

function backspace(editor: Editor): boolean {
  const { state } = editor
  if (!state.selection.empty) return false
  const depth = inlineCodeDepth(state)
  if (depth >= 0) {
    const { $from } = state.selection
    if ($from.parentOffset !== 0) return false
    const from = $from.before(depth)
    return unwrapInlineCode(editor, from, $from.after(depth), from)
  }
  const before = state.selection.$from.nodeBefore
  if (before?.type.name !== INLINE_CODE_NAME) return false
  const from = state.selection.from - before.nodeSize
  return unwrapInlineCode(editor, from, state.selection.from, from + before.content.size)
}

function deleteForward(editor: Editor): boolean {
  const { state } = editor
  if (!state.selection.empty) return false
  const depth = inlineCodeDepth(state)
  if (depth >= 0) {
    const { $from } = state.selection
    if ($from.parentOffset !== $from.parent.content.size) return false
    const from = $from.before(depth)
    return unwrapInlineCode(editor, from, $from.after(depth), from + $from.parent.content.size)
  }
  const after = state.selection.$from.nodeAfter
  if (after?.type.name !== INLINE_CODE_NAME) return false
  const from = state.selection.from
  return unwrapInlineCode(editor, from, from + after.nodeSize, from)
}

// All behaviour lives in commands over ProseMirror positions; the keymap is a
// thin adapter. Exporting commands keeps state/selection assertions independent
// of KeyboardEvent support in jsdom while the Playwright fixture exercises the
// real DOM mapping and native key sequence.
export const inlineCodeCommands = {
  insert: insertInlineCode,
  backtick,
  arrowRight,
  arrowLeft,
  backspace,
  deleteForward,
}

export const InlineCodeEditing = Extension.create({
  name: 'inlineCodeEditing',

  addProseMirrorPlugins() {
    const editor = this.editor
    return [
      new Plugin({
        props: {
          handleTextInput(view, _from, _to, text) {
            const { state } = view
            if (!state.selection.empty || inlineCodeDepth(state) >= 0) return false
            const { $from } = state.selection
            // Chrome can paint an outside selection at the adjacent code DOM
            // edge, then report typed input as if it belonged inside the node.
            // The ProseMirror selection is authoritative: explicitly insert at
            // that logical outside position on either boundary.
            if ($from.nodeBefore?.type.name !== INLINE_CODE_NAME
              && $from.nodeAfter?.type.name !== INLINE_CODE_NAME) return false
            view.dispatch(state.tr.insertText(text, state.selection.from).scrollIntoView())
            return true
          },
          handleKeyDown(_view, event) {
            // A composition key is an IME protocol message, not punctuation or
            // navigation the editor may reinterpret. Leave every such event to
            // the browser, including a composing backtick.
            if (event.isComposing) return false
            if (event.key === '`' && !event.altKey) return backtick(editor)
            if (event.key === 'ArrowRight' && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey) {
              return arrowRight(editor)
            }
            if (event.key === 'ArrowRight' && event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey) {
              return extendSelection(editor, 1)
            }
            if (event.key === 'ArrowLeft' && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey) {
              return arrowLeft(editor)
            }
            if (event.key === 'ArrowLeft' && event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey) {
              return extendSelection(editor, -1)
            }
            if (event.key === 'Backspace' && !event.metaKey && !event.ctrlKey && !event.altKey) {
              return backspace(editor)
            }
            if (event.key === 'Delete' && !event.metaKey && !event.ctrlKey && !event.altKey) {
              return deleteForward(editor)
            }
            return false
          },
          handleDOMEvents: {
            mousedown(view, rawEvent) {
              const event = rawEvent as MouseEvent
              const target = event.target instanceof Element ? event.target.closest('code[data-inline-code]') : null
              if (!(target instanceof HTMLElement)) return false
              const rect = target.getBoundingClientRect()
              const style = getComputedStyle(target)
              const leftEdge = rect.left + parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft)
              const rightEdge = rect.right - parseFloat(style.borderRightWidth) - parseFloat(style.paddingRight)
              if (event.clientX > leftEdge && event.clientX < rightEdge && target.textContent) return false
              const start = view.posAtDOM(target, 0)
              const pos = event.clientX >= rightEdge ? start + (target.textContent?.length ?? 0) : start
              view.dispatch(setCaret(view.state.tr, pos))
              view.focus()
              event.preventDefault()
              return true
            },
          },
          decorations(state) {
            const depth = inlineCodeDepth(state)
            if (depth < 0) return DecorationSet.empty
            const { $from } = state.selection
            const offset = $from.parentOffset
            const edge = offset === 0
              ? 'start'
              : offset === $from.parent.content.size
                ? 'end'
                : undefined
            return DecorationSet.create(state.doc, [
              Decoration.node($from.before(depth), $from.after(depth), {
                'data-inline-code-active': 'true',
                ...(edge ? { 'data-inline-code-caret': edge } : {}),
              }),
            ])
          },
        },
      }),
    ]
  },

})
