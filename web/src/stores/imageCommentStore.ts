import { create } from 'zustand'
import type { ReviewImageAnchor } from '../api'
import type { PendingReviewComment } from '../lib/reviewComments'

// How the lightbox gets a comment system without knowing whose it is.
//
// The lightbox is a global, imperatively-opened overlay (see lightboxStore): it is
// mounted once near the app root and has no idea which page opened it, so it
// cannot fetch a head's review comments itself. The page that DOES know - the
// agent page, which already holds the comments and the head id - registers a
// provider here, and the lightbox reads it.
//
// A store rather than props on open() for one reason that matters: the comments
// have to stay LIVE while the lightbox is open. Publishing a pin should make it
// appear, and a comment arriving from an agent should show up under the picture
// without closing and reopening. Snapshotting them into the open() call would
// freeze both.
//
// Nothing registered means no comment UI at all, which is the correct behaviour
// for every other caller - a chat image, a spawn attachment, the repository
// browser - where there is no head to anchor a comment to.
interface ImageCommentState {
  /** Every review comment on the head currently being viewed. The lightbox picks
   *  out the ones pinned to the picture it is showing. */
  comments: PendingReviewComment[]
  /** Stores a pin. `publish` sends it to the agent immediately ("Comment to
   *  agent"); otherwise it joins the draft review. Null when the current page has
   *  no head to comment on, which is what turns the pin UI off. */
  //
  // The comparison the pin was written on ("main -> abc1234") is recorded by the
  // provider inside this callback rather than being passed in: it is the provider's
  // own state, and threading it through the lightbox would give two places that
  // could disagree about which comparison is on screen.
  submit: ((anchor: ReviewImageAnchor, body: string, publish: boolean) => Promise<void>) | null
  /** Where a remark about a picture the AGENT posted into the chat goes. The chat
   *  is already the thread, so this is a reply - it lands in the composer for you
   *  to send, rather than becoming a second numbered conversation about one of the
   *  chat's own messages. Null on a page with no composer. */
  quote: ((note: PinNote) => void) | null
  /** Where a remark about an ATTACHMENT goes. There is nothing to comment on yet -
   *  no head at spawn time, no message yet in chat - so this is markup on the
   *  prompt being written, recorded against the attachment and serialized when it
   *  is finally sent. Null when nothing is being composed. */
  annotate: ((note: PinNote) => void) | null
  register: (p: Partial<Pick<ImageCommentState, 'comments' | 'submit' | 'quote' | 'annotate'>>) => void
  clear: () => void
}

/** A remark about a spot in a picture, in the form the two non-store destinations
 *  take it: they want prose, not an anchor row, because what they produce is text
 *  a person will read in a message. */
export interface PinNote {
  /** What the picture is called, for the reader. */
  filename: string
  /** Where the agent can open it, when that is a real path (a chat image). */
  path?: string
  /** The position, already rendered ("514,697 px", with the timecode for a clip). */
  position: string
  /** What was said. */
  body: string
}

export const useImageCommentStore = create<ImageCommentState>((set) => ({
  comments: [],
  submit: null,
  quote: null,
  annotate: null,
  // A PARTIAL merge, because the three destinations are registered by different
  // components: the diff viewer knows how to store a review comment, the chat
  // knows how to quote into its composer, and whatever is holding attachments
  // knows how to annotate one. A whole-state register would have each of them
  // clearing the others.
  register: (p) => set(p),
  clear: () => set({ comments: [], submit: null, quote: null, annotate: null }),
}))
