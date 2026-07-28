// Package reviewq is the file-channel a sandboxed head uses to ask the daemon to
// re-read its MR from the forge NOW, instead of waiting up to 30s for the review
// watcher's next tick.
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
// The payload is deliberately empty beyond bookkeeping: the head's MR link lives
// in the daemon's DB, so a request means only "refresh my review file", and the
// refreshed data arrives out-of-band in the review file itself (the Result just
// says whether the refresh happened).
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

// Request asks the daemon to refresh this head's review file from the forge.
type Request struct {
	ReqID string `json:"reqid"`
	TS    string `json:"ts"`
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
