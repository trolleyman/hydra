import { Editor, markInputRule, type JSONContent } from '@tiptap/core'
import { Italic, starInputRegex } from '@tiptap/extension-italic'
import { TaskItem, TaskList } from '@tiptap/extension-list'
import { TableKit } from '@tiptap/extension-table'
import { Markdown, MarkdownManager } from '@tiptap/markdown'
import StarterKit from '@tiptap/starter-kit'
import { Attachment } from './Attachment'
import type { AttachmentRegistry } from './AttachmentRegistry'
import { InlineCode, InlineCodeEditing } from './InlineCode'
import { HighlightedCodeBlock } from './CodeBlock'
import { TableShortcut } from './TableShortcut'
import { InteractiveTable, TableInteraction } from './Table'
import { HydraReference, hydrateReferences } from './Reference'

// Hydra deliberately supports *italic* as a typing convenience but not
// _italic_. Underscores are too common in identifiers, paths and agent output.
const ConservativeItalic = Italic.extend({
  addInputRules() {
    return [markInputRule({ find: starInputRegex, type: this.type })]
  },
})

export function createRichEditorExtensions(attachmentRegistry?: AttachmentRegistry, interactiveNodeViews = false) {
  return [
  StarterKit.configure({
    code: false,
    codeBlock: false,
    heading: { levels: [1, 2, 3] },
    horizontalRule: false,
    italic: false,
    underline: false,
  }),
  ConservativeItalic,
  TaskList,
  TaskItem.configure({ nested: true }),
  TableKit.configure({ table: false }),
  InteractiveTable.configure({ resizable: false, controls: interactiveNodeViews }),
  TableInteraction,
  HighlightedCodeBlock.configure({
    languagePicker: interactiveNodeViews,
    enableTabIndentation: true,
    tabSize: 2,
  }),
  TableShortcut,
  Attachment.configure({ registry: attachmentRegistry }),
  HydraReference,
  InlineCode,
  InlineCodeEditing,
  Markdown,
  ]
}

export const richEditorExtensions = createRichEditorExtensions()

const markdownManager = new MarkdownManager({ extensions: richEditorExtensions })

export function parseRichMarkdown(markdown: string): JSONContent {
  return hydrateReferences(markdownManager.parse(markdown))
}

export function serializeRichMarkdown(document: JSONContent): string {
  return markdownManager.serialize(document)
}

export interface RichEditorOptions {
  element?: Element
  markdown?: string
  content?: JSONContent
  editable?: boolean
  attributes?: Record<string, string>
  attachmentRegistry?: AttachmentRegistry
  interactiveNodeViews?: boolean
}

export function createRichEditor(options: RichEditorOptions = {}): Editor {
  const editor = new Editor({
    element: options.element,
    extensions: createRichEditorExtensions(options.attachmentRegistry, options.interactiveNodeViews),
    content: options.content ?? parseRichMarkdown(options.markdown ?? ''),
    contentType: 'json',
    editable: options.editable ?? true,
    injectCSS: false,
    autofocus: false,
    editorProps: { attributes: options.attributes ?? {} },
  })
  if (options.attachmentRegistry) {
    const unbind = options.attachmentRegistry.bind(editor)
    editor.on('destroy', unbind)
  }
  return editor
}
