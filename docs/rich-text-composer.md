# Rich-text composer: Tiptap implementation plan

Status: **proposed, unbuilt.** Replace the prompt textarea's source-shaped
Markdown highlighting with a structured rich-text editor. The editor should feel
like writing prose, preserve Markdown as Hydra's interchange format, and make
files and images part of the sentence instead of a separate pile of chips.

The proposed foundation is the open-source Tiptap editor on ProseMirror. Tiptap
is an implementation detail, not Hydra's public editor API. The first build step
is a bounded spike: prove the unusual inline-code caret semantics before the rest
of the composer is moved onto it.

## Why change it

`HighlightedTextarea` is a transparent `<textarea>` over a rendered backdrop.
Both layers must contain exactly the same characters with exactly the same
geometry. A Markdown code span therefore has to stay `` `code` `` in the editable
value; it cannot become one editable code capsule with meaningful positions
inside and outside it. The same constraint prevents attachments from living at a
position in the text.

The current implementation is not throwaway work. Carry forward:

- Markdown list continuation and ending an empty list item on Enter.
- Auto-pairing, selection wrapping and removal of empty pairs.
- Variable-length backtick delimiters and CommonMark code-span padding.
- Fenced-code creation on Enter.
- Visual-line Home/End and keeping the caret in view.
- Per-project/per-agent draft restoration and composer sizing.
- Undo and redo spanning typed text and attachment changes.
- Large-paste attachment handling, paste markers and literal paste.
- Leading `!` shell commands in the chat composer.
- Plain Markdown at every backend and agent-facing boundary.

The target is not a document suite. It is a compact, excellent prompt composer
with a deliberately small schema.

## Decision: Tiptap, behind a Hydra-owned API

Use Tiptap's MIT-licensed editor, React integration and open-source extensions.
Tiptap supplies ProseMirror setup, extension packaging, common nodes, commands
and React lifecycle integration; custom selection and deletion behaviour can
still use the underlying ProseMirror transactions directly.

Do not use Tiptap Platform, Cloud, Pro extensions, Pro UI components or Pro
templates. Check every new dependency's installed package licence rather than
inferring it from a similarly named documentation page. Keep the required MIT
notices with Hydra's other third-party notices.

Hydra components must not accept or return Tiptap `Editor`, `Node` or
`Transaction` objects in their ordinary API:

```ts
interface RichComposerValue {
  markdown: string
  attachments: ComposerAttachment[]
}

interface RichComposerProps {
  value: RichComposerValue
  onChange: (value: RichComposerValue) => void
  onSubmit: () => void
  onUpload: (file: File, id: string) => Promise<UploadedAttachment>
}
```

An advanced ref may expose Hydra commands, focus and selection inspection. It
should not expose the whole Tiptap editor by default. This keeps consumers and
drafts portable if the implementation changes.

Direct ProseMirror is also MIT licensed and remains the fallback. It would remove
one abstraction layer, but make Hydra assemble standard editor plumbing before
testing the behaviour that distinguishes this editor. Keep Tiptap if the
inline-code spike below works without fighting its normalization or selection
mapping. Drop to direct ProseMirror only if Tiptap prevents that behaviour or
requires patching its core.

## Document model

Start with this schema:

| Kind | Tiptap/ProseMirror shape | Markdown form |
| --- | --- | --- |
| Paragraph | block node | plain paragraph |
| Heading | block node, levels 1-3 | `#` through `###` |
| Bullet list | block nodes | `- item` |
| Ordered list | block nodes | `1. item` |
| Task list | list item attribute | `- [ ] item` |
| Blockquote | block node | `> text` |
| Code block | block node with language | fenced code |
| Hard break | inline node | Markdown hard break |
| Text | text node | literal text |
| Bold | mark | `**text**` |
| Italic | mark | `*text*` |
| Strike | mark | `~~text~~` |
| Link | mark | `[label](url)` |
| Inline code | editable inline node initially | variable backtick run |
| Attachment | atomic inline node | host-defined reference |

Do not initially support tables, footnotes, arbitrary HTML, text colours,
underlines, font selection, alignment, subscript, superscript or embedded remote
content. They add document-editor surface without improving most prompts.

### Markdown is interchange, not live state

Keep ProseMirror JSON as the live editor state. Parse Markdown when loading a
legacy draft or accepting an external value; serialize it when sending, copying
a mixed rich selection, or notifying a consumer.

Do not parse the full Markdown string back into a document after every
keystroke. That loses selection affinity, node identity, history metadata and
upload state - recreating the current synchronization problem at a higher level.

Byte-for-byte Markdown round trips are not a goal after a rich edit. Semantic
round trips are. The serializer may canonicalize bullet spacing or backtick
delimiter length. Verbatim source can be retained for an untouched legacy draft
until its first rich edit if migration needs it.

## Inline code is the proving feature

Inline code must be editable content, not an atomic chip. For `foo`, the logical
caret positions are distinct:

```text
|[foo]    outside before
[|foo]    inside at offset 0
[f|oo]    inside at offset 1
[fo|o]    inside at offset 2
[foo|]    inside at offset 3
[foo]|    outside after
```

The two pairs at the edges may look close, but differ in what typing and deletion
do. The model and tests must not collapse them.

### Navigation and editing

| Starting state | Input | Result |
| --- | --- | --- |
| Plain caret | Backtick | Insert empty code span, caret inside |
| Plain selection, one line | Backtick | Wrap as one code span, keep content selected |
| Plain selection, multiple lines | Backtick | Wrap as a fenced code block |
| Outside before code | Right | Enter at inside offset 0 |
| Inside offset 0 | Left | Move outside before |
| Inside offset N | Left/Right | Move one grapheme normally |
| Inside final offset | Right | Move outside after |
| Outside after code | Left | Enter at inside final offset |
| Inside code | Backtick | Exit after the span; do not insert a backtick |
| Empty code | Backspace or Delete | Remove the empty span |
| Inside offset 0, non-empty | Backspace | Unwrap to plain text, caret before it |
| Inside final offset, non-empty | Delete | Unwrap to plain text, caret after it |
| Outside immediately after | Backspace | Unwrap code, preserving text |
| Outside immediately before | Delete | Unwrap code, preserving text |
| Partial selection in code | Delete/type | Replace only the selection |
| Entire code node selected | Backspace/Delete | Remove content and node |
| Code command on code | Cmd/Ctrl+backtick | Toggle it back to plain text |

Unwrapping is one history transaction. A second deletion performs the ordinary
neighbouring-character deletion. One key press never both removes formatting and
deletes prose. Arrow movement and deletion operate on grapheme clusters, not
UTF-16 code units. During IME composition no input rule, wrapping rule or
boundary override runs.

### Spike alternatives and gate

Try an inline `code_span` node with `content: 'text*'` first. It naturally gives
the node a visual wrapper and a content DOM. Test whether ProseMirror preserves
the before/inside and inside/after affinities through mouse placement, native
selection, composition and transaction mapping.

If those affinities are unstable, try a normal code mark plus a custom MarkView,
decorations and boundary-navigation plugin. If Tiptap is the obstacle but raw
ProseMirror works, retain the schema/plugin design and replace only the wrapper.

The spike succeeds only when every row above works in Chromium with real keyboard
input and selection. A capsule that merely looks right is not enough.

## Bold, italic and delimiter input

Formatting commands are dependable; Markdown input rules are conveniences:

| State | Cmd/Ctrl+B or Cmd/Ctrl+I |
| --- | --- |
| Selection, none/partly formatted | Apply mark to all of it |
| Selection entirely formatted | Remove mark from all of it |
| Empty selection | Toggle mark for subsequent typing |
| Inside inline/block code | Do nothing; code is literal |

- `**text**`, `*text*` and `~~text~~` convert only after the closing delimiter.
- `_` does not trigger italic in v1; it is too common in paths and identifiers.
- Backslash-escaped markers remain literal.
- Delimiters cannot cross a hard line break.
- Undo immediately after conversion restores the literal markers, following
  ProseMirror's normal input-rule undo convention.

Thus `some_foo bar_thing`, `snake_case`, `_LAYOUT_.tsx` and home/config paths
cannot accidentally format a range.

## Attachments as document nodes

An attachment belongs at a document position. Its node contains a stable
client-generated id and presentation metadata; an upload registry owns the
`File`, progress, server path and errors:

```ts
interface ComposerAttachmentNodeAttrs {
  id: string
  name: string
  kind: 'image' | 'text' | 'pdf' | 'archive' | 'file'
  display: 'chip' | 'thumbnail' | 'preview'
}
```

The node must not contain an absolute upload path in visible DOM, copied HTML or
persisted Markdown. Submission resolves its id through the registry, preserving
the existing separation between prompt text and attachment paths.

| Kind/state | Default in prose | Optional expanded form |
| --- | --- | --- |
| Image | small thumbnail chip + filename | preview with caption |
| Text/code | file chip + name/size | short syntax preview |
| PDF | PDF chip + filename | first-page preview later |
| Other file | generic file chip | metadata only |
| Large pasted text | numbered text-file chip | expandable excerpt |
| Uploading | chip + progress | Cancel action |
| Failed | error chip | Retry and Remove actions |

Attachments are atomic inline nodes. Left/Right moves before or after; clicking
selects one as a unit; Backspace/Delete removes it. Dragging moves the same node
without re-uploading. A block image preview is a presentation toggle on the same
id, not a new attachment.

### Paste/drop and undo

| Action | Transaction/history result |
| --- | --- |
| Paste/drop files | Insert nodes at caret/drop position in one transaction |
| Paste screenshot | Insert an uploading image node immediately |
| Upload progress/success/failure | Update registry/UI, no history entry |
| Remove node | One undoable editor transaction |
| Undo while uploading | Remove node and cancel upload if unreferenced |
| Redo after cancellation | Restore node and restart upload if needed |
| Move node | One transaction, same id and upload |
| Cut node | Clipboard write + one removal transaction |

For plain Markdown, serialize an attachment as `[image1.png]`. Hydra submission
derives those readable references from document order and passes resolved upload
records separately. Do not also store generated filename markers as ordinary
text beside the nodes; that would duplicate state.

V1 may forbid duplicate nodes referring to one attachment id. If duplicates are
later allowed, cancel an upload only when the document and retained history no
longer reference it.

## Block behaviour

### Headings, lists and quotes

Support heading levels 1-3. `# ` through `### ` convert after Space. Enter at the
end creates a paragraph; Backspace at the start of an empty heading converts it
to a paragraph. Keep their composer typography compact.

Support `- `, `* `, `1. ` and `- [ ] `. Enter continues a list and an empty item
exits it. Tab/Shift+Tab indent/outdent only in lists. Elsewhere Tab retains focus
navigation. `> ` creates a blockquote; an empty quoted line exits it.

### Code blocks

A triple-backtick line followed by Enter creates a block; an optional language
token seeds its language. Code blocks:

- Use the code font and optional syntax highlighting.
- Disable spellcheck, smart quotes and Markdown inline rules.
- Indent/outdent with Tab/Shift+Tab.
- Preserve literal newlines and whitespace.
- Copy raw code when the selection is wholly inside one block.
- Copy fenced Markdown as part of a broader selection.
- Leave on ArrowDown from the final visual line after one boundary step.
- Unwrap when empty and Backspace is pressed at its start.
- Offer "Attach as file" for a paste over the large-paste threshold.

A language picker can follow after the first composer release.

## Links and later extensions

Pasting a URL over selected text creates a link; pasting it at a caret inserts
the URL. Rich HTML paste keeps safe supported structure but drops source colours,
fonts, classes and scripts.

High-value follow-ups are `@file`, `@branch`, `@commit` and `@agent` reference
nodes. A file reference can open Hydra's repository/diff view while serializing
to readable Markdown for agents that know nothing about structured references.

A `/` menu may offer Text, Heading, List, Task list, Quote, Code block and Attach
file, but only at the start of an empty block. Defer URL cards, remote embeds,
tables, math, collaboration and comments inside the composer.

## Clipboard contract

Copy a rich selection as both:

- `text/plain`: canonical Markdown, except a selection wholly inside inline or
  block code copies its literal content.
- `text/html`: a small safe representation for other rich editors.

Paste precedence:

1. Files, handled once as attachments.
2. A Hydra private structured fragment for lossless internal copy/paste.
3. Sanitized HTML restricted to the schema.
4. Plain text.

Cmd/Ctrl+Shift+V always inserts literal plain text and runs no attachment, HTML
or Markdown transformation. Preserve the existing deliberate second-paste path
for inlining a large text attachment, preferably as an explicit node command.

## Shell-command mode

The chat composer's leading `!command` is a different language and submission
path. Do not represent shell source as rich prose. Compare:

1. Receiving `!` in an otherwise empty document switches the content area to the
   existing plain Bash-highlighted editor. Deleting it returns to rich mode.
2. A dedicated shell block disables all rich input rules.

Prefer the first if it preserves execution, history recall, drafts and caret
behaviour with less coupling. A mode switch is one undoable operation and must
not reinterpret a rich document that happens to serialize with leading `!`.

## Undo, drafts and uploads

Use ProseMirror history for document and selection transactions. Attachment
insert/remove/move actions are document transactions and naturally share text
history. Upload progress and completion are reconciliation, not user actions, so
mark their updates `addToHistory: false`. This replaces, rather than layers on,
`useComposerHistory` for migrated composers.

Persist a versioned draft:

```ts
interface RichComposerDraftV1 {
  version: 1
  doc: JSONContent
  attachments: PersistedDraftAttachment[]
}
```

Undo history need not survive reload. Node order, ids, display mode and settled
upload paths must. Load old string drafts by parsing Markdown and place existing
attachments at unambiguous filename markers; otherwise append them after the
final paragraph without dropping data. Do not rewrite an old draft until the
user edits or explicitly migrates it.

## Surfaces and migration

`HighlightedTextarea` has many callers. Do not replace them together.

| Surface | Plan |
| --- | --- |
| Active-agent chat composer | First production integration |
| Spawn composer, compact/full | Second integration |
| Review reply/comment composer | Later; Markdown subset, no attachments first |
| Image-pin note | Later only if compact UI still fits |
| Commit/review control text | Keep textarea unless rich editing adds value |
| Config/uncommitted-message editors | Keep textarea; source fidelity matters |
| Shell editor | Keep dedicated source editor |

Retain `HighlightedTextarea`, `textareaEdit`, `autoPair` and the current Markdown
source renderer while non-rich callers remain.

## Reusable package boundary

Keep editor code free of Hydra stores, routes and API models:

```text
web/src/lib/rich-editor/
  core/          schema, Markdown, commands, public types
  extensions/    inline code, boundaries, attachments, input rules, paste
  react/         composer, formatting menu, attachment view
  test/          editor harness

web/src/lib/hydra-composer/
  uploads, drafts, submission, references
```

Keep it inside `web/` until two Hydra surfaces use it and the API settles. Then
extract a workspace package if it is genuinely reusable. Publishing before the
browser selection model and host boundary stabilize would freeze the wrong API.

## One document language for editing and rendering

The structured composer should also retire the accidental split between "the
thing being edited" and "Markdown after it was sent". Editing and display share:

- The supported schema and Markdown parser/serializer.
- Node/mark semantics and stable attachment ids.
- Typography tokens, code/attachment surfaces and spacing rules.
- A registry giving each node type an editable view and a static view.
- Clipboard and plain-text fallbacks.

They should not share one literal component. Transcript rows must be static,
cheap, selectable and free of contenteditable history/selection plugins.
Rendering an editor instance for every message would regress long transcript
performance and accessibility. Use two views over one document:

```text
RichDocument
  -> EditableDocumentView (one live Tiptap editor in the composer)
  -> StaticDocumentView   (plain React/DOM in a sent user bubble)
  -> Markdown             (backend, replay and external clipboard)
```

Assistant and old transcript messages can contain Markdown beyond the composer
schema, including GFM tables. Keep the full `MarkdownRenderer` for them. A user
message created by the rich composer uses the shared static view while it is
optimistic. After reload, parse its Markdown into the supported user-message
schema when possible and fall back to `MarkdownRenderer` without losing content.
Do not narrow the transcript's Markdown language to match the composer.

### Seamless send transition

The chat already inserts user messages optimistically. Preserve the rich document
snapshot beside the optimistic row's Markdown and client id. Send then moves one
document rather than clearing an editor before unrelated Markdown appears:

1. Capture the editor content's layout and stable node ids.
2. Insert the optimistic static bubble from the same rich snapshot.
3. Clear the editor and release its upload references in the same visual update.
4. Move the document content from composer to bubble; fade/grow the bubble
   surface around it instead of moving the whole composer chrome.
5. Reconcile the daemon echo into that row by client id, with no second animation
   or reparse flash.

Prefer the View Transitions API when available, with a unique transition name
derived from the client id and stable names for attachment nodes. A small FLIP
overlay can be the fallback if View Transitions cannot span the React commits
cleanly. `prefers-reduced-motion: reduce` performs the same atomic state update
without movement.

Animate only when the send is accepted locally and its destination is visible. A
queued message targets its queued bubble; an immediate one targets the transcript.
If the reader has scrolled away, do not drag content across the viewport to an
off-screen row. A failed send leaves the document in the editor and never starts
a transition.

Attachments move by stable id from their exact sentence position to the same
position in the bubble. Upload completion during the animation changes
presentation, not identity. Focus returns to the empty composer immediately; an
animated clone is never interactive and cannot steal selection or pointer events.

This shared renderer can later support editing a queued message in place,
expanding attachments without changing position, and draft previews without a
Markdown round trip.

## Accessibility and browser requirements

- One accessible multiline textbox name and description.
- Toggle buttons expose formatting through `aria-pressed`.
- Attachment nodes expose names and selected/upload/error states.
- Every pointer action has a keyboard equivalent.
- Escape closes menus without losing the editor selection.
- Tab remains focus navigation outside lists/code blocks.
- Screen readers announce code entry/exit without decorative punctuation noise.
- Spellcheck follows the existing preference and is disabled inside code.
- IME composition is never interrupted by rules or React rerenders.
- Touch handles can land around attachments and within inline code.
- Bidirectional prose is tested; Left/Right cannot blindly assume document order
  equals visual direction.

Initially support the Chromium version installed by Hydra's Playwright suite.
Exercise Firefox and WebKit before advertising a standalone reusable library.

## Test strategy

### Pure and command tests

- Markdown parse/serialize for every supported node and mark.
- Backticks in code choose a safe delimiter and padding.
- Unsupported HTML loses styling/structure safely, not its text.
- Attachment serialization never leaks local paths.
- `_` inside identifiers never becomes emphasis.
- Every navigation, formatting, attachment and undo table row above asserts both
  document JSON and logical selection.
- Cross-node selections: prose into code, code through attachment into marked
  text, adjacent code/attachments, Select All, delete, undo and redo.

### Real-browser tests

jsdom cannot validate native contenteditable selection. Playwright must use real
key presses and pointer input for:

- Every Left/Right position and deletion boundary around code.
- Mouse placement on code/attachment padding and content.
- Shift+Arrow selection crossing nodes in both directions.
- Composition events with no mid-composition conversion.
- Emoji and combining-character navigation/deletion.
- Rich copy/paste, literal paste and safe HTML paste.
- File/image paste, upload completion, undo/redo and drag-move.
- Composer auto-grow, scrolling, submit, shell mode and draft restoration.
- Composer-to-optimistic-bubble transitions for queued/immediate sends,
  attachment identity, daemon reconciliation and reduced-motion behaviour.
- A clean console in the simulation server.

Use the active simulation agent page described in
[web-agent-page.md](web-agent-page.md). Add an editor-only harness route/fixture
for exhaustive selection cases so failures are not coupled to chat WebSockets.

## Build order and gates

1. **Dependency/licence audit.** Pin only required MIT Tiptap/ProseMirror
   packages, record notices and measure the production bundle.
2. **Inline-code spike.** Paragraphs, text and `code_span` only. Browser-test the
   six-position model, selection, deletion, undo, composition and clipboard.
   This is the Tiptap go/no-go gate.
3. **Reusable core.** Hydra-owned API/value types, Markdown parser/serializer,
   editable/static view registry, commands, marks, links, input rules and unit
   tests. No composer integration.
4. **Attachment node/adapter.** Fake asynchronous uploader first; prove that
   reconciliation skips history and undo can cancel/restart correctly.
5. **Block subset.** Headings 1-3, lists/tasks, blockquotes and code blocks.
6. **Chat integration.** Preserve send, queue recall, shell mode, uploads, large
   paste, drafts, resizing/auto-grow, disabled states and focus return. Migrate
   old drafts without loss; keep a development flag until parity tests pass.
7. **Static user-message view and send transition.** Preserve the rich snapshot
   on optimistic rows, morph composer content into immediate/queued bubbles and
   reconcile the daemon echo in place.
8. **Spawn integration.** Reuse the adapter in compact/full layouts and ensure
   surrounding selectors do not rerender on every editor transaction.
9. **Polish/discovery.** Formatting menu, attachment display toggles, optional
   `/` menu and accessible announcements.
10. **Broader surfaces.** Evaluate review replies and image-pin notes separately.
11. **Extraction decision.** After two production consumers, audit Hydra imports
    and extract a workspace package only if there is a real reuse case.

Every phase leaves plain Markdown submission working. Do not add a parallel rich
message backend protocol.

## First-release acceptance criteria

- Every inline-code boundary row works with keyboard and pointer input.
- Submitted Markdown is semantically equivalent and contains no editor sentinels.
- Existing drafts/attachments load without loss.
- Text, formatting and attachments share coherent undo/redo.
- Upload reconciliation adds no undo entries.
- Large/literal paste, shell commands, queue recall, submit, resize/auto-grow and
  focus restoration retain current behaviour.
- Images/files can be placed, moved and removed within prose.
- Optimistic user bubbles share the document renderer and can move seamlessly
  from the composer without a reparse/layout flash; reduced motion disables it.
- IME, graphemes, accessibility and touch selection have explicit coverage.
- Bundle increase is measured; editor-only code is lazy-loaded if useful.
- Only MIT packages are included and notices retained.
- The rich editor exposes a Hydra-owned API.

## Deliberately not

- A rich-document backend chat protocol.
- Collaborative editing or multiplayer cursors.
- Tiptap Cloud, Platform, Pro extensions, Pro UI or templates.
- Tables, arbitrary HTML, colours, fonts, alignment or office fidelity.
- Replacing source/config/shell editors with contenteditable.
- Publishing a general package before two Hydra integrations prove the boundary.
- Byte-identical Markdown after a rich edit.
