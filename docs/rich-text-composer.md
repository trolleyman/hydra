# Rich-text composer: Tiptap implementation plan

Status: **integrated into production chat, Spawn and compact Markdown notes.**
The schema, Markdown boundary, inline-code behaviour, attachments, blocks,
language picker, tables and reusable controlled React adapter are built. Active
chat and both Spawn layouts use the structured editor for prose, while chat
retains `HighlightedTextarea` for its deliberately separate `!` shell mode.
Markdown remains Hydra's interchange format and files/images can live at their
document positions.

The editor uses open-source Tiptap on ProseMirror. Tiptap
is an implementation detail, not Hydra's public editor API. The first build step
is a bounded spike: prove the unusual inline-code caret semantics before the rest
of the composer is moved onto it.

## Implementation progress

Completed 2026-08-29:

- Pinned `@tiptap/core`, `@tiptap/react` and `@tiptap/pm` at 3.30.5. All three
  declare MIT, as do all 13 resolved `prosemirror-*` packages. No paid Tiptap
  package is present. Add the distributable licence notice when editor code first
  enters the production bundle.
- Built the isolated `code_span` as a content-bearing inline node plus a boundary
  plugin. Tiptap is a viable foundation; the go/no-go gate is green.
- Added pure command tests and a dedicated real-Chromium Playwright fixture. The
  browser suite covers six-position traversal in both directions, Shift+Arrow,
  all deletion/unwrap edges, empty removal, partial/whole/cross-node selections,
  selection wrapping, structural undo, pointer padding, IME suppression, raw
  code copy and joined-emoji graphemes.
- Measured the isolated spike at 293.0 KB minified / 89.4 KB gzip. It is currently
  test-only and unreferenced by the app, so the production bundle delta is zero.
  Re-measure after the reusable core is imported and prefer a lazy composer chunk.
- Added the reusable schema and Markdown boundary on Tiptap's beta Markdown
  package, pinned at 3.30.5. Unit coverage now round-trips headings, lists,
  blockquotes, fenced code, links and prose marks, including safe variable-length
  inline-code delimiters. The browser fixture runs against this complete schema.
- Replaced Tiptap's underscore italic input rule with Hydra's star-only rule.
  Incoming `_italic_` remains valid Markdown, but typing identifiers and paths
  cannot unexpectedly turn underscores into formatting.
- Added the atomic attachment node and external upload registry. Files, upload
  state and resolved paths never enter the document or Markdown. Document
  presence drives upload lifecycle, so undo aborts an in-flight upload and redo
  restarts it; asynchronous reconciliation adds no history transaction.
- Completed the initial block schema: level 1-3 headings, bullet/ordered/task
  lists, blockquotes, fenced code and hard breaks all share the same Markdown
  parser/serializer. Task item checked state has explicit round-trip coverage.
- `THIRD_PARTY_NOTICES.md` carries the Tiptap, ProseMirror and Marked MIT
  notices required by the production bundle.
- Refined inline-code presentation to use the browser's spatial caret without
  a second active-state indicator. Empty capsules reserve a compact, real
  typing slot, and the regular E2E runner explicitly excludes the fixture that
  requires the dedicated rich-editor server.
- Made a third consecutive backtick upgrade the empty inline capsule into a
  fenced code block. The block's language selector keeps language choice in the
  structured document and Markdown.
- Added open-source TableKit support with GFM Markdown parsing/serialization,
  an insert action, contextual row/column/delete controls and an overflow-safe
  editable table surface in production composers.
- Added a Hydra-owned controlled `MarkdownComposer` React adapter. Its public
  value is Markdown and its event surface does not expose ProseMirror state, while an
  optional editor handle supports host formatting controls.
- Added document attachment NodeViews backed by the external registry. Chips
  show uploading/failed state, retry failed uploads, remove with a structural
  transaction, cancel/restart work across undo/redo and expose resolved paths in
  document order without leaking them into editor JSON or Markdown.
- Moved the active-agent production chat composer onto the lazy-loaded rich
  adapter. Existing Markdown drafts, external attachment chips, paste markers,
  combined undo/redo, queue recall, send/queue semantics, auto-grow, resize,
  disabled state, spellcheck and focus restoration remain intact. A leading
  `!` switches to the existing Bash-highlighted source textarea; returning to
  normal text switches back without losing the draft or caret.
- Moved production attachments into the rich document. Image nodes show a local
  thumbnail while uploading; other files remain compact inline chips. A single
  document transaction now controls the chip and its Markdown marker, with an
  explicit history boundary so undo preserves earlier typing. Versioned JSON
  drafts retain node positions across reloads, while older Markdown drafts are
  migrated at their existing `[filename]` markers.
- Added presentation-only tokens to rendered chat Markdown: backtick-wrapped
  commit-shaped hashes get a commit chip, and repository links whose visible
  label is the filename/path get a navigable file chip. Structured file, commit,
  branch and agent references use the shared selectable tooltip surface instead
  of native browser titles. The composer, copied Markdown and submission value
  remain literal.
- Hardened production paste semantics. Files retain first refusal during normal
  paste, supported HTML structure is accepted through the schema while source
  styling/scripts are discarded, and URL-over-selection creates a link.
  Ctrl/Cmd+Shift+V bypasses files and HTML and inserts the clipboard's plain
  text literally.
- Kept inline presentation structurally quiet: editable code capsules and file
  attachments stay within the composer's existing 20px line box, while rendered
  commit/file chips stay within chat's existing 21px line box. Real-Chromium
  assertions guard both heights so tokenization cannot make surrounding prose
  jump vertically.
- Added code-block language selection without adding a formatting header. Each
  fenced block owns a compact searchable picker in its top-right corner. It
  offers known languages, accepts an arbitrary Markdown info string and updates
  live Prism decorations in the editable code. Known display labels such as
  `Python` canonicalize to Prism's language id. The picker portals outside
  clipped composer cards and flips above its trigger near the viewport bottom.
  The shared highlighter keeps editable and rendered token colours aligned.
- Added the composer-to-message handoff. Immediate and queued sends capture the
  composer's screen position and animate the optimistic user bubble from it;
  reduced-motion users get an instant handoff. The daemon echo settles the same
  client-id-keyed row in place, so it cannot duplicate or restart the motion.
- Reused the lazy rich adapter in both Spawn layouts. Spawn keeps its existing
  Markdown request boundary, per-project drafts, large-paste/file workflow,
  combined prompt/attachment history, resizing and submit shortcuts while
  gaining the same marks, inline code, blocks and tables as production chat.
- Spawn attachments use the same document node and upload registry as chat.
  Images and files stay at their insertion point, render once inside the prompt,
  open in the shared lightbox and undo/redo as document transactions. The whole
  visible Spawn editor height is a focus target, including blank space below the
  first line.
- Fixed the follow-up production polish: outer document margins no longer move
  the first composer line, an empty code capsule reserves a visible typing slot,
  and provider-assigned echo ids reconcile with the existing optimistic user
  bubble by text fallback.
- Added `| ` at the start of an otherwise empty paragraph as a two-column table
  shortcut. It creates a header row plus one body row and places the selection
  in the first header cell; pipes elsewhere remain literal.
- Finished release hardening. Fenced code now indents/outdents with
  Tab/Shift+Tab, exits from its final line with ArrowDown and unwraps when empty
  with Backspace. Tables start as a two-column header plus one body row. Tab and
  Enter grow columns and rows, Shift+Arrow selects row/column ranges, and
  draggable gutters select whole rows or columns for deletion. A cell-local
  menu inserts adjacent rows/columns and sets Markdown column alignment. Header
  tinting and zebra rows communicate structure without bold header text.
  The behavior fixture runs in Chromium, Firefox and WebKit (engine-unsupported
  clipboard-permission checks are skipped). The lazy `MarkdownComposer` chunk,
  including reference discovery and the command menu, is 292.03 KB minified /
  94.61 KB gzip in the current production build. The shared attachment/core
  chunk is 304.93 KB minified / 95.74 KB gzip.

The spike found two browser facts now captured in the design. Chrome does not
natively walk through a content-bearing inline node, so the plugin owns every
Left/Right grapheme step. It also maps the inside-start DOM caret to the node's
left outer edge (and the outside-after caret to its right inner edge) even though
ProseMirror's logical positions remain distinct. Hydra preserves those logical
positions through keyboard behavior while relying on the native caret's spatial
placement, without synthetic edge decorations or zero-width sentinel characters.
Pair insertion also needs an explicit history boundary so undo clears typed
content before removing the empty capsule.

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

## Decision: Tiptap with a Markdown value boundary

Use Tiptap's MIT-licensed editor, React integration and open-source extensions.
Tiptap supplies ProseMirror setup, extension packaging, common nodes, commands
and React lifecycle integration; custom selection and deletion behaviour can
still use the underlying ProseMirror transactions directly.

Do not use Tiptap Platform, Cloud, Pro extensions, Pro UI components or Pro
templates. Check every new dependency's installed package licence rather than
inferring it from a similarly named documentation page. Keep the required MIT
notices with Hydra's other third-party notices.

The ordinary controlled value is Markdown. Advanced frontend host hooks expose
the editor for attachment, selection and keyboard integration; they remain
internal to Hydra and are not a reusable package API. The value boundary is:

```ts
interface MarkdownComposerProps {
  value: string
  onChange: (markdown: string) => void
}
```

The adapter owns parsing, schema, clipboard rules, selection menus and rendering.
Chat and Spawn own upload manifests, drafts, submission and source shell mode.
The internal advanced handle exposes focus and the editor; no editor objects are
sent to the backend.

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
| Table | table/row/header/cell nodes | GFM pipe table |
| Hard break | inline node | Markdown hard break |
| Text | text node | literal text |
| Bold | mark | `**text**` |
| Italic | mark | `*text*` |
| Strike | mark | `~~text~~` |
| Link | mark | `[label](url)` |
| Inline code | editable inline node initially | variable backtick run |
| Attachment | atomic inline node | host-defined reference |

Do not initially support footnotes, arbitrary HTML, text colours,
underlines, font selection, alignment, subscript, superscript or embedded remote
content. They add document-editor surface without improving most prompts.

Math remains a follow-up. Tiptap's open-source Mathematics extension is viable,
but its `$$inline$$` / `$$$block$$$` input syntax differs from the usual Markdown
`$inline$` / `$$block$$` boundary. Hydra should only add it alongside explicit
parse/serialize adapters and rendered-message support, not as an editor-only
format that changes meaning after send.

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

Hydra owns Space, Backspace and Delete while the caret is inside inline code.
This keeps spaces as literal U+0020 characters and deletes one grapheme per
press; Chromium's temporary contenteditable NBSP cannot duplicate a space or
create a two-state Backspace loop.

Unwrapping is one history transaction. A second deletion performs the ordinary
neighbouring-character deletion. One key press never both removes formatting and
deletes prose. Arrow movement and deletion operate on grapheme clusters, not
UTF-16 code units. During IME composition no input rule, wrapping rule or
boundary override runs.

Home and End leave an inline-code node at its outside edges. In particular, End
from the final character of a paragraph-ending code span lands after the span,
so subsequent typing is ordinary prose rather than remaining trapped in code.

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

Attachments are atomic inline nodes. Left/Right moves only before or after them;
Backspace/Delete removes them. Clicking an image chip opens the shared lightbox
without moving the document caret into the node. Their neutral, thumbnail-led
surface matches sent-message attachment chips and does not create a trailing
blank line. The node view follows registry updates, so a local or restored image
preview appears even when its URL becomes available after the node mounts.
Dragging moves the same node without re-uploading. A block image preview is a
presentation toggle on the same id, not a new attachment.

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
- Insert a literal newline on Shift+Enter even when the host uses Enter to send.
- Copy raw code when the selection is wholly inside one block.
- Copy fenced Markdown as part of a broader selection.
- Leave on ArrowDown from the final visual line after one boundary step.
- Unwrap when empty and Backspace is pressed at its start.
- Offer "Attach as file" for a paste over the large-paste threshold.

The compact language picker searches known languages and accepts arbitrary
Markdown info strings without reserving a toolbar row. Live syntax highlighting,
code-font ligatures, indentation and explicit exit/unwrap handling are built in
production composers. Clicking unused composer or code-block space places the
caret at the corresponding document edge.

## Links and later extensions

Pasting a URL over selected text creates a link; pasting it at a caret inserts
the URL. Rich HTML paste keeps safe supported structure but drops source colours,
fonts, classes and scripts.

`@file`, `@branch`, `@commit` and `@agent` reference nodes serialize as readable
`@kind[value]` Markdown, so agents and the backend need no structured-message
protocol. Known branches and agents are suggested while files and commits accept
an explicit value.

A `/` menu offers Text, Heading, List, Task list, Quote, Code block, Table and
Attach file at the start of an empty block. Defer URL cards, remote embeds,
math, collaboration and comments inside the composer. Tables are included in
the production schema with contextual controls and narrow-width scrolling.

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
interface MarkdownComposerDraftV1 {
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
| Review reply/comment composer | Rich Markdown editor; no attachments |
| Image-pin note | Rich Markdown editor in the anchored popover |
| Question option notes and Other | Compact rich Markdown editors; settled values render their structure |
| Commit/review control text | Keep textarea unless rich editing adds value |
| Config/uncommitted-message editors | Keep textarea; source fidelity matters |
| Shell editor | Keep dedicated source editor |

Retain `HighlightedTextarea`, `textareaEdit`, `autoPair` and the current Markdown
source renderer while non-rich callers remain.

## Internal module boundary

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

This is a Hydra-owned internal module. Keep the editor API independent of Hydra
stores, routes and generated API models, but do not plan a workspace or external
package extraction. A concrete second product can justify that work later; an
abstract reuse goal cannot.

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
performance and accessibility. Markdown is the source of truth at rest, with
two purpose-built views:

```text
Markdown
  -> MarkdownComposer (one live Tiptap document while editing)
  -> RichMarkdown     (a private parsed tree rendered as plain React/DOM)
  -> backend, replay and external clipboard
```

`RichMarkdown` is the memoized boundary for persisted or external Markdown. It
parses into a private HAST tree and immediately renders that tree; the parsed
representation is neither an application data model nor persisted state.
Assistant and old transcript messages can contain syntax beyond the composer
schema, so the static renderer continues to support the complete existing
GFM/media/repository-link language. Do not narrow the transcript language to
match the composer.

Static attachment and Hydra-reference nodes are now semantic presentation nodes.
An attachment keeps its sentence position when a sent message contains its
stable `[filename]` boundary and the temporary upload manifest identifies that
filename; legacy messages without one retain the trailing chip fallback. Hydra
references use ordinary Markdown links with typed `hydra://` targets, such as
`[main](hydra://branch/main)`. The static renderer turns those links into typed
chips. Legacy `@file[...]`, `@commit[...]`, `@branch[...]` and `@agent[...]`
references remain readable and are canonicalized to link form when edited.

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

## Optional follow-ups

The first release, structured references and start-of-line command menu are
complete. Choose further work from actual use rather than expanding it
speculatively. A shared static viewer can reuse more node presentation between
the editor and sent bubbles. Math remains explicitly deferred until its Markdown
boundary and renderer agree.

The editor remains an internal Hydra module; package extraction is not a goal.

## Build order and gates

1. **Dependency/licence audit - DONE.** Pinned only the required MIT packages;
   recorded the versions/audit above and measured the isolated bundle. The
   production notice waits until production actually distributes the code.
2. **Inline-code spike - DONE.** Paragraphs, text and `code_span` only. The
   six-position model, selection, deletion, undo, composition, pointer and
   clipboard tests pass in real Chromium. Tiptap passed the go/no-go gate.
3. **Reusable core - DONE.** Hydra-owned editor factory, shared extension
   registry, Markdown parser/serializer, marks, links, conservative input rules
   and unit/browser tests are built. The controlled React adapter and narrow
   Markdown value/event API are built; advanced frontend hosts use internal
   editor hooks for selections, attachments and keyboard integration.
4. **Attachment node/adapter - DONE.** The atomic safe-metadata node and external
   upload registry cancel on undo, restart on redo and keep paths out of
   Markdown/JSON. Production upload wiring, inline chips/thumbnails, retry,
   removal and versioned draft restoration are built.
5. **Block subset - DONE.** Headings 1-3, bullet/ordered/task lists,
   blockquotes, fenced code and hard breaks are registered and round-trip tested.
6. **Chat integration - DONE.** The active-agent composer now uses the
   lazy rich adapter for normal messages and retains the source textarea for
   shell mode. Send, queue recall, uploads, paste markers, drafts, resizing,
   disabled states, spellcheck, focus return and combined text/attachment undo
   have component and real-Chromium coverage. Attachments live at their document
   positions as inline NodeViews and still submit the existing path manifest.
7. **Static user-message view and send transition - DONE.** Rendered chat
   Markdown recognizes commit and file tokens without changing source. Immediate
   and queued messages fly from the composer into a client-id-keyed optimistic
   bubble, and the daemon echo reconciles that same row in place.
8. **Spawn integration - DONE.** Compact and full-page Spawn layouts use the
   lazy adapter while the surrounding selectors retain stable callbacks and the
   existing Markdown submission contract.
9. **Release hardening - DONE.** Code-block exit/indent/unwrap, spreadsheet-like
   table navigation and range selection, cell-local table actions, narrow
   layout and bundle measurement are complete. The browser fixture supports
   Chromium, Firefox and WebKit; the current local run verifies Chromium.
10. **Broader surfaces - DONE.** Review replies, image-pin notes, question option
    notes and question Other answers use the rich Markdown adapter and render
    settled Markdown structure.
11. **Optional discovery - DONE.** Structured Hydra references and a
     start-of-line `/` menu are available in chat and Spawn.

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
- Composition-event and grapheme behavior have automated coverage. Physical IME,
  touchscreen selection and assistive technology need manual device checks.
- Bundle increase is measured; editor-only code is lazy-loaded if useful.
- Only MIT packages are included and notices retained.
- The rich editor exposes a Hydra-owned API.

## Deliberately not

- A rich-document backend chat protocol.
- Collaborative editing or multiplayer cursors.
- Tiptap Cloud, Platform, Pro extensions, Pro UI or templates.
- Math, arbitrary HTML, colours, fonts, alignment or office fidelity.
- Replacing source/config/shell editors with contenteditable.
- Publishing a general package before two Hydra integrations prove the boundary.
- Byte-identical Markdown after a rich edit.

## Integration behavior

- Composition key events bypass both host shortcuts and editor keymaps. Menu
  confirmation does not consume an IME confirmation key.
- Agent slash commands take precedence over block discovery when they match.
  Code spans and blocks do not offer slash or reference discovery.
- With Enter sends disabled, the schema handles paragraph/list continuation and
  leaving an empty list item. Shift+Enter inserts a hard break; code and tables
  retain their contextual keyboard behavior.
- A successful send starts a fresh editor history. Switching Spawn projects also
  starts a separate history, so undo cannot restore another project's text.
- Spawn saves a versioned document snapshot beside its Markdown draft. The
  snapshot is restored only when its Markdown matches, retaining attachment
  positions without trusting a stale snapshot over the portable draft.
- Draft upload manifests contain the attachments still present in the document.
  Removing a chip cannot bring it back on navigation or reload.
- Repeating a large Spawn paste replaces its attachment at the structured
  selection. This is one undoable document transaction; Markdown character
  offsets are never used as document positions.
- Rebinding a draft restarts any upload cancelled during editor teardown.
- Reference-looking text inside code remains literal. Rich clipboard copies
  preserve reference metadata, and attachment atoms are accepted only when the
  receiving editor's upload registry knows their id.
- Static Markdown keeps unsafe URL schemes inert and tolerates malformed typed
  reference links without crashing the transcript.

The implementation is an internal prompt editor. Math and collaborative editing
remain outside its scope.

The dedicated `rich_editor` Hydra runner preserves browser interaction coverage
between changes. Production composer tests also fail on unexpected console and
page errors. See [testing.md](testing.md) for runner behavior and engine coverage.

The code language picker measures its displayed width and reserves that footprint
on the first source line with a presentation-only float. Narrow composers wrap
source around the picker without covering characters or adding a toolbar row.
Code surfaces disable spellcheck independently of the surrounding prose setting.

## Browser editor choice

Settings -> Browser -> Rich text editor selects rich editing or highlighted
Markdown source for chat, both Spawn layouts, review replies, image-pin notes
and question notes/Other answers. The setting is local to this browser and is
enabled by default. Reset to defaults includes it.

The saved choice applies after reloading the page. Every composer uses the same
choice for that page lifetime, so changing the setting cannot replace an active
input or cancel an upload. Markdown drafts and uploaded attachment manifests are
shared by both modes. An unchanged structured snapshot retains exact attachment
positions when rich editing is enabled again; source edits load through Markdown
and restore attachments at their filename markers.

## Mobile focus

Rich editors settle structural plugins when their view mounts, before autofocus
or host commands run. This establishes trailing paragraphs and table headers
without adding an undo step or emitting a draft edit. Synchronous iOS/Android
focus events then operate on the same document as the enclosing focus command.

The application viewport fixes its scale at 1 and disables user scaling to
prevent phone focus zoom from shifting the composer. Composer text retains its
configured size.

The full-page Spawn footer keeps attachment, agent/model and options controls
beside the Spawn Agent button on phone screens. The button uses tighter
horizontal padding on narrow layouts.

Chat commit pills align their hash and change counts with the first subject line.
Their vertical padding gives wrapped subjects room above and below the text.
