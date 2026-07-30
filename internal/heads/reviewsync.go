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
//   - Syncing is free, waking is a model turn. The checkout is moved whenever it
//     is behind; the reviewer is only *told* when its session is live, and then
//     once per sync with every new commit batched into one message rather than
//     one message per commit.

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"strings"
	"time"

	"github.com/trolleyman/hydra/internal/api"
	"github.com/trolleyman/hydra/internal/db"
	"github.com/trolleyman/hydra/internal/git"
	"github.com/trolleyman/hydra/internal/paths"
	"github.com/trolleyman/hydra/internal/session"
)

// reviewSyncInterval is how often the reviewer's checkout is compared with its
// head's branch tip. Deliberately slow: a head that commits five times in a
// minute should cost its reviewer ONE catch-up message listing five commits, not
// five messages and five model turns. It is also the retry cadence for a
// reviewer that was mid-turn when its head moved.
const reviewSyncInterval = 30 * time.Second

// reviewSyncCommitsCap bounds how many commit subjects the catch-up message
// spells out. A reviewer returning to a head that has moved a hundred commits
// does not need a hundred subjects - it needs to know it moved, and by how much.
const reviewSyncCommitsCap = 20

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

// SyncReviewCheckout moves one head's review checkout onto branch, and tells its
// reviewer what arrived if the session is live. A no-op when the head has no
// review checkout (nobody has opened its Review tab), when the checkout is
// already there, or when its reviewer is mid-turn.
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
	live := reg.IsLive(slotID)
	// Mid-turn: leave the tree exactly where the reviewer is reading it and come
	// back on a later tick. Only a live session can be mid-turn - a stale
	// "running" left behind by a dead one must not pin the checkout forever.
	if live && reviewIsMidTurn(projectRoot, slotID) {
		return
	}

	// The commits to report, resolved from the OLD position before it moves.
	// Only meaningful for a fast-forward; a rebase or reset makes "what arrived"
	// the wrong question, and reviewSyncMessage says so instead.
	var added []git.CommitInfo
	if ff, err := git.IsAncestor(projectRoot, current, tip); err == nil && ff {
		added, _ = git.ListFirstParentCommits(projectRoot, current, tip)
	}

	if _, err := EnsureReviewCheckout(projectRoot, headID, branch); err != nil {
		log.Printf("warn: review sync: move %s's review checkout to %s: %v", headID, branch, err)
		return
	}
	log.Printf("review sync: %s's review checkout %s -> %s", headID, shortSHA(current), shortSHA(tip))
	if !live {
		// Silent: there is no one to tell. The reviewer picks the new tree up
		// whenever it is next opened, with no catch-up message for work it never
		// saw the older version of.
		return
	}
	content, err := json.Marshal([]map[string]any{{
		"type": "text", "text": reviewSyncMessage(added, current, tip),
	}})
	if err != nil {
		return
	}
	if err := reg.SendChatUser(slotID, content); err != nil {
		log.Printf("warn: review sync: notify %s: %v", slotID, err)
	}
}

// reviewIsMidTurn reports whether a review session is working right now, read
// from the status.json its own hooks write (seedHead points them at the SLOT id,
// so this is the reviewer's status and not the head's).
func reviewIsMidTurn(projectRoot, slotID string) bool {
	info := ReadAgentStatus(projectRoot, slotID)
	return info != nil && (info.Status == api.Running || info.Status == api.Starting)
}

// reviewSyncMessage is what the reviewer is told when its tree moves under it.
// It has to do two jobs at once: carry the facts, and stop a conscientious agent
// from immediately re-reviewing everything (a turn per commit is exactly the
// flood this batching exists to avoid).
func reviewSyncMessage(added []git.CommitInfo, from, to string) string {
	var b strings.Builder
	b.WriteString("[Hydra] The head has committed, so your checkout has been moved forward to its branch tip.\n\n")
	switch {
	case len(added) == 0:
		fmt.Fprintf(&b, "Your checkout was at %s and is now at %s. The branch did not simply move forward (a rebase, amend or reset), so treat anything you read before this point as possibly stale.\n",
			shortSHA(from), shortSHA(to))
	default:
		fmt.Fprintf(&b, "%s since you last looked, now at %s:\n\n", countCommits(len(added)), shortSHA(to))
		for i, c := range added {
			if i == reviewSyncCommitsCap {
				fmt.Fprintf(&b, "- ...and %d more\n", len(added)-reviewSyncCommitsCap)
				break
			}
			fmt.Fprintf(&b, "- %s %s\n", c.ShortSHA, c.Subject)
		}
	}
	b.WriteString("\nAny file you read earlier may have changed; re-read before relying on it. You do not need to re-review the whole branch - say briefly whether this changes anything you have already raised, and wait for the human otherwise.")
	return b.String()
}

func countCommits(n int) string {
	if n == 1 {
		return "1 new commit"
	}
	return fmt.Sprintf("%d new commits", n)
}

func shortSHA(sha string) string {
	if len(sha) > 8 {
		return sha[:8]
	}
	return sha
}
