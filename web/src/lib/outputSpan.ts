// One coloured piece of a line a TOOL printed, as opposed to a line of some
// file. A file's line goes through a grammar and comes back as token HTML; a
// tool's line has no grammar to point at - `git status`, `git check-ignore`,
// `du` each print a fixed shape - so it is classified by shape and comes back
// as spans (lib/gitOutput, lib/duOutput), which the chat's output panel renders
// directly.
export interface OutputSpan {
  text: string
  // Classes to colour the text with; '' takes the panel's own colour. Usually
  // Tailwind (the palette each module keeps), but a span carrying a fragment of
  // some LANGUAGE - the ignore pattern a `git check-ignore -v` prints - takes
  // the app's `token` classes instead, so that fragment reads the same here as
  // it does in the file it was quoted out of.
  cls: string
}
