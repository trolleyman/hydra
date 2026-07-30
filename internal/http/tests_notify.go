package http

// Telling a head its tests went red.
//
// The value is narrow and real: you leave a head running, it finishes, its suite
// goes red, and without this it sits there believing it is done until you come
// back and read the panel yourself. With it, the head finds out and fixes it.
//
// Everything about this is shaped by the fact that it costs a model turn
// (docs/review-agent.md, "one shape, four rules"):
//
//   - It fires only while the head is IDLE (notifyIdle). That is not politeness -
//     it is what makes the feature safe. A notification that could land mid-turn
//     would interrupt the very fix it asked for, and a head that commits, sees
//     red, fixes, commits again is a loop we would be paying for.
//   - It is deduped per (runner, commit). A suite re-run against the same tip is
//     the same news, and the same news twice is noise. A NEW commit that is still
//     red does notify again, which is right: "still broken after that change" is
//     a different fact from "broken".
//   - The message is one line naming the runner and the count. The agent pulls
//     the failures with get_test_logs, which it already has - a failure costs a
//     turn, not a transcript full of log.

import (
	"context"
	"fmt"
	"log"
	"strings"
	"sync"
	"time"

	"github.com/trolleyman/hydra/internal/config"
	"github.com/trolleyman/hydra/internal/heads"
	hydratests "github.com/trolleyman/hydra/internal/tests"
)

// testNotifyInterval is how often the daemon looks for a newly-failing verdict.
// Slow on purpose: this is a backstop over a cache that only changes when a run
// settles, and a head that just went red is not more useful for being told two
// seconds sooner.
const testNotifyInterval = 20 * time.Second

// testNotifyBatchDelay collects the runners that failed for one head, so a project
// with four suites that all go red on one commit sends one message rather than
// four.
const testNotifyBatchDelay = 5 * time.Second

// testNotifySeen remembers what has already been reported, keyed
// head -> "runner@commit". Memory-only: a daemon restart re-notifying a still-red
// suite once is a far smaller cost than persisting this, and the head being idle
// is still required.
var testNotifySeen = struct {
	sync.Mutex
	m map[string]map[string]bool
}{m: map[string]map[string]bool{}}

var testNotifyBatcher = newNotifyBatcher(testNotifyBatchDelay)

// RunTestFailureNotifier watches for test runs settling FAILING and tells the
// (idle) head about them. Iterates all projects, like the other daemon loops.
func (s *Server) RunTestFailureNotifier(ctx context.Context, roots func() []string) {
	t := time.NewTicker(testNotifyInterval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			for _, root := range roots() {
				s.notifyFailingTestsOnce(ctx, root)
			}
		}
	}
}

// notifyFailingTestsOnce runs one pass over a project's heads.
func (s *Server) notifyFailingTestsOnce(ctx context.Context, projectRoot string) {
	cfg, err := config.Load(projectRoot)
	if err != nil || !cfg.NotifyTestFailures() {
		return
	}
	hs, err := heads.ListHeads(ctx, s.Sessions, s.DB, projectRoot)
	if err != nil {
		return
	}
	mgr := s.Tests.Manager(projectRoot)
	for i := range hs {
		head := &hs[i]
		if head.Archived || head.Ephemeral || head.Branch == nil {
			continue
		}
		// Idle only. Checked here as well as in notifyHead so a busy head does not
		// even burn its dedup entries - it should be told when it stops, not have
		// the news marked delivered while it was working.
		if s.headIsWorking(projectRoot, head.ID) {
			continue
		}
		v := hydratests.Version{Ref: *head.Branch}
		for _, r := range s.testRunnersFor(projectRoot, v, cfg) {
			rep, ok, err := mgr.Peek(r.Name, v)
			if err != nil || !ok || rep.Status != hydratests.StatusFailing {
				continue
			}
			if !markTestNotified(head.ID, r.Name, rep.Key) {
				continue
			}
			headID, name, failed := head.ID, r.Name, rep.Failed
			testNotifyBatcher.add(head.ID, fmt.Sprintf("%s (%s)", name, plural(failed, "failure", "failures")), func(items []string) {
				s.notifyHead(s.BackgroundCtx, projectRoot, headID, notifyIdle, reasonTestsFailed, fmt.Sprintf(
					"Tests are failing on your branch: %s. Use the get_test_logs tool for the output, fix what is broken, and commit.",
					strings.Join(items, ", ")))
			})
			log.Printf("tests: %s went red for %s (%s)", name, headID, rep.Key)
		}
	}
}

// markTestNotified records a (runner, commit) as reported and reports whether it
// is new. The key includes the report's cache key, which is the commit - so a
// re-run of the same tip is silent and a new commit that is still red is not.
func markTestNotified(headID, runner, key string) bool {
	testNotifySeen.Lock()
	defer testNotifySeen.Unlock()
	seen := testNotifySeen.m[headID]
	if seen == nil {
		seen = map[string]bool{}
		testNotifySeen.m[headID] = seen
	}
	k := runner + "@" + key
	if seen[k] {
		return false
	}
	seen[k] = true
	return true
}

// ForgetTestNotifications drops a head's dedup entries, so a purged-and-respawned
// id does not inherit "already told" from its predecessor.
func ForgetTestNotifications(headID string) {
	testNotifySeen.Lock()
	defer testNotifySeen.Unlock()
	delete(testNotifySeen.m, headID)
}
