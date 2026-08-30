import { useRef, useState } from 'react'
import { Bold, Braces, CodeXml, Columns3, Heading1, Heading2, ImagePlus, Italic, List, ListChecks, Plus, Quote, Redo2, Rows3, Strikethrough, Table2, Trash2, Undo2 } from 'lucide-react'
import type { Editor } from '@tiptap/core'
import { insertAttachment, type AttachmentKind } from '../../lib/rich-editor/Attachment'
import { inlineCodeCommands } from '../../lib/rich-editor/InlineCode'
import { RichComposer, type RichComposerHandle } from '../../lib/rich-editor/RichComposer'
import { CODE_LANGUAGES } from '../../lib/rich-editor/codeLanguages'
import { Tooltip } from '../Tooltip'
import { HighlightedTextarea } from '../HighlightedTextarea'
import { Markdown } from '../../lib/MarkdownRenderer'
import { SettingSection } from './shared'

const INITIAL_MARKDOWN = `## A richer prompt

Try **bold**, *italic*, ~~strike~~, links, lists and the unusual \`inline code\` capsule.

- Arrow into and out of inline code one boundary at a time
- Type a backtick to create or exit a capsule
- Undo attachment insertion along with text

- [ ] Try a task
- [x] Keep Markdown as the interchange format

> The editor and the preview below use the same document schema.

| Surface | Format |
| :--- | ---: |
| Editor | Structured |
| Boundary | Markdown |`

function ToolbarButton({ label, active = false, onClick, children }: {
  label: string
  active?: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <Tooltip content={label} side="top">
      <button
        type="button"
        onClick={onClick}
        aria-label={label}
        aria-pressed={active || undefined}
        className={`flex h-8 w-8 items-center justify-center rounded-md transition-colors cursor-pointer ${
          active
            ? 'bg-blue-100 text-blue-700 dark:bg-blue-500/20 dark:text-blue-300'
            : 'text-gray-500 hover:bg-gray-100 hover:text-gray-800 dark:text-gray-400 dark:hover:bg-white/[0.07] dark:hover:text-gray-100'
        }`}
      >
        {children}
      </button>
    </Tooltip>
  )
}

function kindFor(file: File): AttachmentKind {
  if (file.type.startsWith('image/')) return 'image'
  if (file.type === 'application/pdf') return 'pdf'
  if (file.type.startsWith('text/')) return 'text'
  return 'file'
}

export function RichTextLab() {
  const [currentMarkdown, setCurrentMarkdown] = useState(INITIAL_MARKDOWN)
  const [revision, setRevision] = useState(0)
  const fileInput = useRef<HTMLInputElement>(null)
  const richComposerRef = useRef<RichComposerHandle>(null)
  const [editor, setEditor] = useState<Editor | null>(null)

  // `revision` also refreshes toolbar active states on selection-only changes.
  // Reading it here makes that relationship explicit to the hooks linter.
  void revision

  function updateFromOldComposer(value: string) {
    setCurrentMarkdown(value)
  }

  function addFiles(files: File[]) {
    if (!editor) return
    for (const file of files) {
      insertAttachment(editor, {
        id: crypto.randomUUID(),
        name: file.name || 'pasted file',
        kind: kindFor(file),
        display: file.type.startsWith('image/') ? 'thumbnail' : 'chip',
      })
      editor.commands.insertContent(' ')
    }
    editor.commands.focus()
  }

  return (
    <div data-rich-text-lab>
      <SettingSection
        title="Rich text composer lab"
        description="A safe place to exercise the proposed chat composer before it replaces the production text box. Nothing here is saved or sent."
      >
        <div className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm dark:border-white/10 dark:bg-gray-800">
          <div className="flex flex-wrap items-center gap-0.5 border-b border-gray-200 px-2 py-1.5 dark:border-white/10">
            {editor ? <>
            <ToolbarButton label="Undo" onClick={() => editor.chain().focus().undo().run()}><Undo2 className="h-4 w-4" /></ToolbarButton>
            <ToolbarButton label="Redo" onClick={() => editor.chain().focus().redo().run()}><Redo2 className="h-4 w-4" /></ToolbarButton>
            <span className="mx-1 h-5 w-px bg-gray-200 dark:bg-white/10" />
            <ToolbarButton label="Bold" active={editor.isActive('bold')} onClick={() => editor.chain().focus().toggleBold().run()}><Bold className="h-4 w-4" /></ToolbarButton>
            <ToolbarButton label="Italic" active={editor.isActive('italic')} onClick={() => editor.chain().focus().toggleItalic().run()}><Italic className="h-4 w-4" /></ToolbarButton>
            <ToolbarButton label="Strike" active={editor.isActive('strike')} onClick={() => editor.chain().focus().toggleStrike().run()}><Strikethrough className="h-4 w-4" /></ToolbarButton>
            <ToolbarButton label="Inline code" active={editor.isActive('inlineCode')} onClick={() => inlineCodeCommands.backtick(editor)}><Braces className="h-4 w-4" /></ToolbarButton>
            <span className="mx-1 h-5 w-px bg-gray-200 dark:bg-white/10" />
            <ToolbarButton label="Heading 1" active={editor.isActive('heading', { level: 1 })} onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}><Heading1 className="h-4 w-4" /></ToolbarButton>
            <ToolbarButton label="Heading 2" active={editor.isActive('heading', { level: 2 })} onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}><Heading2 className="h-4 w-4" /></ToolbarButton>
            <ToolbarButton label="Bullet list" active={editor.isActive('bulletList')} onClick={() => editor.chain().focus().toggleBulletList().run()}><List className="h-4 w-4" /></ToolbarButton>
            <ToolbarButton label="Task list" active={editor.isActive('taskList')} onClick={() => editor.chain().focus().toggleTaskList().run()}><ListChecks className="h-4 w-4" /></ToolbarButton>
            <ToolbarButton label="Blockquote" active={editor.isActive('blockquote')} onClick={() => editor.chain().focus().toggleBlockquote().run()}><Quote className="h-4 w-4" /></ToolbarButton>
            <ToolbarButton label="Code block" active={editor.isActive('codeBlock')} onClick={() => editor.chain().focus().toggleCodeBlock().run()}><CodeXml className="h-4 w-4" /></ToolbarButton>
            <label className="ml-1">
              <span className="sr-only">Code block language</span>
              <select
                aria-label="Code block language"
                disabled={!editor.isActive('codeBlock')}
                value={editor.isActive('codeBlock') ? String(editor.getAttributes('codeBlock').language ?? '') : ''}
                onChange={(event) => editor.chain().focus().updateAttributes('codeBlock', { language: event.target.value || null }).run()}
                className="h-8 rounded-md border border-gray-200 bg-white px-2 text-xs text-gray-600 disabled:cursor-not-allowed disabled:opacity-40 dark:border-white/10 dark:bg-gray-900 dark:text-gray-300"
              >
                {CODE_LANGUAGES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </label>
            <span className="mx-1 h-5 w-px bg-gray-200 dark:bg-white/10" />
            <ToolbarButton label="Insert files" onClick={() => fileInput.current?.click()}><ImagePlus className="h-4 w-4" /></ToolbarButton>
            <span className="mx-1 h-5 w-px bg-gray-200 dark:bg-white/10" />
            <ToolbarButton label="Insert table" active={editor.isActive('table')} onClick={() => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}><Table2 className="h-4 w-4" /></ToolbarButton>
            {editor.isActive('table') && (
              <>
                <ToolbarButton label="Add row below" onClick={() => editor.chain().focus().addRowAfter().run()}><Rows3 className="h-4 w-4" /><Plus className="-ml-1 h-2.5 w-2.5" /></ToolbarButton>
                <ToolbarButton label="Add column right" onClick={() => editor.chain().focus().addColumnAfter().run()}><Columns3 className="h-4 w-4" /><Plus className="-ml-1 h-2.5 w-2.5" /></ToolbarButton>
                <ToolbarButton label="Delete row" onClick={() => editor.chain().focus().deleteRow().run()}><Rows3 className="h-4 w-4" /><Trash2 className="-ml-1 h-2.5 w-2.5" /></ToolbarButton>
                <ToolbarButton label="Delete column" onClick={() => editor.chain().focus().deleteColumn().run()}><Columns3 className="h-4 w-4" /><Trash2 className="-ml-1 h-2.5 w-2.5" /></ToolbarButton>
                <ToolbarButton label="Delete table" onClick={() => editor.chain().focus().deleteTable().run()}><Trash2 className="h-4 w-4" /></ToolbarButton>
              </>
            )}
            <input
              ref={fileInput}
              type="file"
              multiple
              className="hidden"
              onChange={(event) => {
                addFiles(Array.from(event.target.files ?? []))
                event.target.value = ''
              }}
            />
            </> : <span className="px-2 py-1 text-xs text-gray-500">Loading editor...</span>}
          </div>
          <RichComposer
            ref={richComposerRef}
            value={currentMarkdown}
            onChange={(value) => {
              setCurrentMarkdown(value)
              setRevision((revision) => revision + 1)
            }}
            onEditor={setEditor}
            onSelectionChange={() => setRevision((revision) => revision + 1)}
            ariaLabel="Rich text editor demo"
            className="min-h-44 px-4 py-3"
          />
        </div>
        <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
          Try arrows at both edges of inline code, Backspace/Delete at its boundaries, Ctrl/Cmd+B, typing <code className="font-mono">*italic*</code>, three backticks for a code block, table row/column controls, and inserting a local file.
        </p>
      </SettingSection>

      <SettingSection
        title="Current composer"
        description="Hydra's existing transparent textarea and syntax-highlight backdrop. Edit here and the structured editor above updates from the same Markdown."
      >
        <HighlightedTextarea
          value={currentMarkdown}
          onChange={(event) => updateFromOldComposer(event.target.value)}
          aria-label="Current Markdown composer demo"
          wrapperClassName="h-52 w-full overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm dark:border-white/10 dark:bg-gray-800"
          textClassName="px-4 py-3 text-xs leading-5"
        />
      </SettingSection>

      <SettingSection
        title="Rendered message"
        description="The current chat Markdown renderer, fed by the exact same value as both editors. This is what a sent message looks like today."
      >
        <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm dark:border-white/10 dark:bg-gray-800">
          <Markdown text={currentMarkdown} variant="chat" className="chat-font chat-leading text-gray-800 dark:text-gray-100" />
          <div className="mt-4 border-t border-gray-200 pt-2 text-2xs text-gray-400 dark:border-white/10 dark:text-gray-500">
            {currentMarkdown.length} Markdown characters shared by all three views
          </div>
        </div>
      </SettingSection>
    </div>
  )
}
