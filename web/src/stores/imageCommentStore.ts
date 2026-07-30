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
  register: (p: { comments: PendingReviewComment[]; submit: ImageCommentState['submit'] }) => void
  clear: () => void
}

export const useImageCommentStore = create<ImageCommentState>((set) => ({
  comments: [],
  submit: null,
  register: ({ comments, submit }) => set({ comments, submit }),
  clear: () => set({ comments: [], submit: null }),
}))
