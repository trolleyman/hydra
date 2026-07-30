// Package reviewq is the file-channel a sandboxed head uses to ask the daemon
// for something only the host can answer - originally just "re-read my MR from
// the forge NOW" instead of waiting up to 30s for the review watcher's next
// tick, and now also the head's own tests/artifacts/services status, which lives
// in the daemon's managers (services state is in-memory there, so no amount of
// disk reading from the sandbox would find it).
//
// Every forge call runs host-side with the user's `gh`/`glab` credentials - the
// sandbox has neither those credentials nor (under hard egress) a route to the
// forge - so the in-sandbox `hydra mcp` server cannot fetch its own review state.
// It writes a request file into a per-head writable dir and polls for the result
// the host writes back, exactly like the gate approval channel and gitq: one
// request per file keyed by a caller-chosen reqid, <reqid>.req.json holding the
// Request and <reqid>.result.json the Result. A request with a result file is
// "done" and skipped by ListRequests, which is the idempotency the watcher relies
// on.
//
// A refresh request's payload is deliberately empty beyond bookkeeping: the
// head's MR link lives in the daemon's DB, so the request means only "refresh my
// review file", and the refreshed data arrives out-of-band in the review file
// itself (the Result just says whether the refresh happened). The status ops
// instead answer inline through Result.Message, already rendered for the agent -
// all the formatting stays host-side next to the managers it describes.
package reviewq

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"braces.dev/errtrace"
)

const (
	reqSuffix    = ".req.json"
	resultSuffix = ".result.json"
)

// Op selects what the daemon should do. An empty Op means OpRefresh.
type Op string

const (
	// OpRefresh re-reads the MR from the forge and rewrites the head's review file.
	OpRefresh Op = "refresh"
	// OpNote records a LOCAL-ONLY reply on a review thread. It is never sent to the
	// forge: an agent has no forge credentials, and Hydra only ever writes to a PR
	// as an explicit user action (docs/review-threads.md).
	OpNote Op = "note"
	// OpComments reads Hydra's OWN review comments on this head - the numbered,
	// line-anchored ones the user (or a reviewer agent) left in the diff viewer,
	// which exist with or without a forge MR (docs/review-agent.md). Published
	// only: a draft is never shown to an agent. Numbers narrows it to specific
	// comments; empty means all of them.
	OpComments Op = "comments"
	// OpAddComment appends a review comment as this agent, anchored to a line.
	// It is published on write - an agent has no drafts, since a draft exists so a
	// person can think before speaking.
	OpAddComment Op = "add_comment"
	// OpHeadStatus returns a rendered summary of this head's own tests, artifacts
	// and services. Read-only: it never starts a test run or a generation.
	OpHeadStatus Op = "head_status"
	// OpTestLogs returns the captured output of one test runner's latest run for
	// this head, tail-limited. Split from OpHeadStatus so the common "am I green?"
	// question stays a few hundred tokens and only a real failure pays for a log.
	OpTestLogs Op = "test_logs"
	// OpRunTests / OpRunArtifacts discard this head's cached verdict/output for its
	// branch tip and start a fresh run. The ONLY write ops in the status family:
	// they kick work and return immediately, so the agent polls OpHeadStatus for
	// the result rather than holding a tool call open for minutes.
	OpRunTests     Op = "run_tests"
	OpRunArtifacts Op = "run_artifacts"
)

// Request asks the daemon to do one thing for this head's review state.
type Request struct {
	ReqID string `json:"reqid"`
	TS    string `json:"ts"`
	Op    Op     `json:"op,omitempty"`

	// note
	ThreadID string `json:"thread_id,omitempty"`
	Body     string `json:"body,omitempty"`

	// comments / add_comment. Numbers selects specific comments to read (empty =
	// all); Path/Line/ReplyTo anchor a new one.
	Numbers []int  `json:"numbers,omitempty"`
	Path    string `json:"path,omitempty"`
	Line    int    `json:"line,omitempty"`
	ReplyTo int    `json:"reply_to,omitempty"`

	// test_logs / run_tests / run_artifacts. Runner names one test runner or one
	// artifact script; empty means all of them.
	Runner string `json:"runner,omitempty"`
	Tail   int    `json:"tail,omitempty"` // lines from the end; 0 = the host's default
}

// Result is the host's outcome. Refreshed is false when the daemon deliberately
// skipped the forge round trip (an unlinked head, or a snapshot young enough that
// re-fetching would only burn rate limit) - the review file is still the answer,
// it just wasn't rewritten. Message explains a failure to the agent.
type Result struct {
	OK        bool   `json:"ok"`
	Refreshed bool   `json:"refreshed,omitempty"`
	Message   string `json:"message,omitempty"`
}

// WriteRequest writes r into dir as <reqid>.req.json (creating dir).
func WriteRequest(dir string, r Request) error {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return errtrace.Wrap(err)
	}
	data, err := json.Marshal(r)
	if err != nil {
		return errtrace.Wrap(err)
	}
	return errtrace.Wrap(os.WriteFile(filepath.Join(dir, r.ReqID+reqSuffix), data, 0o644))
}

// ListRequests returns the unanswered requests in dir (those without a result
// file yet), oldest-first by TS. A missing dir is not an error (no requests).
func ListRequests(dir string) ([]Request, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, errtrace.Wrap(err)
	}
	var out []Request
	for _, e := range entries {
		name := e.Name()
		if !strings.HasSuffix(name, reqSuffix) {
			continue
		}
		reqid := strings.TrimSuffix(name, reqSuffix)
		if _, err := os.Stat(filepath.Join(dir, reqid+resultSuffix)); err == nil {
			continue // already answered
		}
		data, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			continue
		}
		var r Request
		if err := json.Unmarshal(data, &r); err != nil {
			continue
		}
		out = append(out, r)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].TS < out[j].TS })
	return out, nil
}

// WriteResult records the host's outcome for reqid as <reqid>.result.json.
func WriteResult(dir, reqid string, res Result) error {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return errtrace.Wrap(err)
	}
	data, err := json.Marshal(res)
	if err != nil {
		return errtrace.Wrap(err)
	}
	return errtrace.Wrap(os.WriteFile(filepath.Join(dir, reqid+resultSuffix), data, 0o644))
}

// ReadResult reads the result for reqid (ok=false if not written yet).
func ReadResult(dir, reqid string) (Result, bool, error) {
	data, err := os.ReadFile(filepath.Join(dir, reqid+resultSuffix))
	if err != nil {
		if os.IsNotExist(err) {
			return Result{}, false, nil
		}
		return Result{}, false, errtrace.Wrap(err)
	}
	var res Result
	if err := json.Unmarshal(data, &res); err != nil {
		return Result{}, false, errtrace.Wrap(err)
	}
	return res, true, nil
}

// Sweep deletes answered request/result pairs older than keep entries, so a
// long-lived head that refreshes on every review tool call doesn't accumulate
// files forever. Best-effort.
func Sweep(dir string, keep int) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	var done []string
	for _, e := range entries {
		name := e.Name()
		if !strings.HasSuffix(name, resultSuffix) {
			continue
		}
		done = append(done, strings.TrimSuffix(name, resultSuffix))
	}
	if len(done) <= keep {
		return
	}
	sort.Strings(done) // reqids are nanosecond timestamps, so this is oldest-first
	for _, reqid := range done[:len(done)-keep] {
		_ = os.Remove(filepath.Join(dir, reqid+reqSuffix))
		_ = os.Remove(filepath.Join(dir, reqid+resultSuffix))
	}
}
