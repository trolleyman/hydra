import type { PinNote } from '../stores/imageCommentStore'

// How a pin on a picture reads once it becomes text.
//
// Two of the three destinations produce prose rather than a stored comment: a
// remark about a picture the agent posted is a REPLY, and a remark about an
// attachment is MARKUP on the prompt being written. Both end up in a composer,
// so both need the same thing - a line that says which picture and where, and
// the remark itself.
//
// The wording differs because the two are about different moments. A reply is
// about something that already happened ("about that screenshot"), and can name
// the file the agent can open. An annotation is an instruction about something
// being sent along with it ("in this image"), and the path does not exist yet -
// the agent will receive the file, not fetch it.
//
// Both keep the remark on its own line rather than inlining it, so a multi-line
// remark does not lose its shape, and so the location stays scannable when
// several are stacked in one message.

/** A reply about a picture the agent posted into the chat. */
export function formatQuote(note: PinNote): string {
  // The path is what the agent can actually open - it posted the file, so it can
  // read it back. Falling back to the filename keeps the sentence sensible when
  // there is no path (an image referenced by URL rather than by file).
  const where = note.path || note.filename
  return `About \`${where}\` at ${note.position}:\n\n${note.body}`
}

/** An instruction about an attachment being sent with this message. */
export function formatAnnotation(note: PinNote): string {
  return `In \`${note.filename}\` at ${note.position}: ${note.body}`
}

/** Appends `text` to what is already in a composer, with a blank line between -
 *  so a second pin does not run into the first, and neither runs into whatever
 *  was already being typed. Leading/trailing whitespace is normalised so the
 *  result never opens with blank lines. */
export function appendToComposer(existing: string, text: string): string {
  const before = existing.replace(/\s+$/, '')
  return before ? `${before}\n\n${text}` : text
}
