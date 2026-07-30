package heads

// Keeping a head's reviewer looking at the head's current work.
//
// A review checkout is created at the branch tip when the slot first starts and
// then never moved again by anything else - so without this a long-lived reviewer
// answers questions about the commit it happened to open on while the head
// commits past it. That failure is silent from both ends: the tree looks like a
// normal checkout, and the reviewer has no way to know it is stale.
//
// Two rules the loop is built around:
//
//   - Never move the tree under a running turn. The reviewer reads files across
//     several tool calls; swapping the tree mid-turn makes it read half of one
//     commit and half of another. A busy reviewer is simply skipped and picked up
//     on a later tick.
//   - Syncing is free, waking is a model turn - so the sync is SILENT. It moves
//     the tree and tells the reviewer nothing.
//
// That second rule was briefly broken, and the bill made the case better than the
// argument did: every commit a head made cost its reviewer a catch-up message,
// each one a full model turn spent re-reading a diff nobody had asked about, and a
// head that commits fifteen times in a task paid for fifteen of them. What the
// reviewer needs instead is to know that its tree moves under it at all, which is
// one line in its system prompt (reviewSystemPrompt) costing nothing per commit:
// re-read before relying on anything you read earlier.
//
// If an automatic pass is ever wanted, hang it on the head's `finished`
// transition - one deliberate moment per task - not on commits.

import (
	"context"
	"log"
	"time"

	"github.com/trolleyman/hydra/internal/api"
	"github.com/trolleyman/hydra/internal/db"
	"github.com/trolleyman/hydra/internal/git"
	"github.com/trolleyman/hydra/internal/paths"
	"github.com/trolleyman/hydra/internal/session"
)

// reviewSyncInterval is how often the reviewer's checkout is compared with its
// head's branch tip. Deliberately slow: catching up a few seconds late costs
// nothing, and this is also the retry cadence for a reviewer that was mid-turn
// when its head moved.
const reviewSyncInterval = 30 * time.Second

// RunReviewSyncWatcher keeps every head's review checkout on its branch tip.
//
// roots is re-evaluated each tick so projects added or removed at runtime are
// picked up, matching the other daemon loops.
func RunReviewSyncWatcher(ctx context.Context, reg *session.Registry, store *db.Store, roots func() []string) {
	ticker := time.NewTicker(reviewSyncInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			for _, root := range roots() {
				SyncReviewCheckoutsOnce(reg, store, root)
			}
		}
	}
}

// SyncReviewCheckoutsOnce runs one sync pass over a project's review checkouts.
func SyncReviewCheckoutsOnce(reg *session.Registry, store *db.Store, projectRoot string) {
	agents, err := store.ListAgents(projectRoot)
	if err != nil {
		log.Printf("warn: review sync: list agents: %v", err)
		return
	}
	for _, a := range agents {
		if a.BranchName == "" {
			continue
		}
		SyncReviewCheckout(reg, projectRoot, a.ID, a.BranchName)
	}
}

// SyncReviewCheckout moves one head's review checkout onto branch, silently. A
// no-op when the head has no review checkout (nobody has opened its Review tab),
// when the checkout is already there, or when its reviewer is mid-turn.
func SyncReviewCheckout(reg *session.Registry, projectRoot, headID, branch string) {
	dir := paths.GetReviewCheckoutDirFromProjectRoot(projectRoot, headID)
	// No checkout: nothing has been reviewed here. Deliberately NOT created on
	// demand - a head nobody reviews must not pay for a worktree, and the first
	// open checks out the tip anyway (StartReviewSession -> EnsureReviewCheckout).
	current, err := git.ResolveRef(dir, "HEAD")
	if err != nil {
		return
	}
	tip, err := git.ResolveRef(projectRoot, branch)
	if err != nil || tip == current {
		return
	}

	slotID := ReviewSessionID(headID)
	// Mid-turn: leave the tree exactly where the reviewer is reading it and come
	// back on a later tick. Only a live session can be mid-turn - a stale
	// "running" left behind by a dead one must not pin the checkout forever.
	if reg.IsLive(slotID) && reviewIsMidTurn(projectRoot, slotID) {
		return
	}

	if _, err := EnsureReviewCheckout(projectRoot, headID, branch); err != nil {
		log.Printf("warn: review sync: move %s's review checkout to %s: %v", headID, branch, err)
		return
	}
	// Logged, not sent. The reviewer is never woken for this; it learns that its
	// tree moves under it from its system prompt, and re-reads.
	log.Printf("review sync: %s's review checkout %s -> %s", headID, shortSHA(current), shortSHA(tip))
}

// reviewIsMidTurn reports whether a review session is working right now, read
// from the status.json its own hooks write (seedHead points them at the SLOT id,
// so this is the reviewer's status and not the head's).
func reviewIsMidTurn(projectRoot, slotID string) bool {
	info := ReadAgentStatus(projectRoot, slotID)
	return info != nil && (info.Status == api.Running || info.Status == api.Starting)
}

func shortSHA(sha string) string {
	if len(sha) > 8 {
		return sha[:8]
	}
	return sha
}
