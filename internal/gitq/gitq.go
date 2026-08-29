// Package gitq is the file-channel the in-sandbox git tools use to have the
// daemon perform a git write-operation on the head's behalf, for the readonly
// git-isolation mode where .git is read-only in the sandbox (so the sandbox can't
// write it) and the daemon can't be reached over its socket from inside the box.
// It mirrors the gate approval channel: the sandbox writes a request file into a
// per-head writable dir and polls for a result file the host writes back.
//
// One request per file, keyed by a caller-chosen reqid: <reqid>.req.json holds
// the Request, <reqid>.result.json the Result. A request with a result file is
// "done" and skipped by ListRequests (the idempotency the watcher relies on).
//
// Every request carries an Op selecting the git operation (commit, reset, revert,
// add, rebase, ...); the host watcher dispatches on it, running each through the
// matching own-branch-guarded git helper. All ops act on the head's OWN branch
// inside its worktree - never another branch or a path outside the worktree.
package gitq

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

// Op names the git write-operation a Request performs. An empty Op is treated as
// OpCommit for backwards compatibility with the original commit-only channel.
type Op string

const (
	OpCommit         Op = "commit"          // stage + commit
	OpReset          Op = "reset"           // move HEAD (soft/mixed/hard) or unstage paths
	OpRevert         Op = "revert"          // revert a commit (new commit)
	OpAdd            Op = "add"             // stage whole files or specific line ranges
	OpRebase         Op = "rebase"          // non-interactive plan-based history edit
	OpRebaseContinue Op = "rebase_continue" // resume a rebase after resolving conflicts
	OpRebaseAbort    Op = "rebase_abort"    // abort an in-progress rebase
	OpCherryPick     Op = "cherry_pick"     // apply a commit onto the head (new commit)
	OpMerge          Op = "merge"           // merge a ref INTO the head's branch
	OpMergeContinue  Op = "merge_continue"  // conclude a conflicted merge after resolving
	OpMergeAbort     Op = "merge_abort"     // abort an in-progress merge
	OpStash          Op = "stash"           // set aside / restore / inspect uncommitted work
)

// AddSpec stages a file, optionally restricted to specific line ranges in the
// current (new) file. Empty Ranges stages the whole file.
type AddSpec struct {
	Path   string   `json:"path"`
	Ranges [][2]int `json:"ranges,omitempty"` // inclusive [start,end] new-file line pairs
}

// RebaseStep is one line of a plan-based interactive rebase.
type RebaseStep struct {
	Commit  string `json:"commit"`            // full or abbreviated sha of a commit above Base
	Action  string `json:"action"`            // pick | reword | squash | fixup | drop
	Message string `json:"message,omitempty"` // new message for reword / squash
}

// Request is a git write-operation the sandbox asks the host to perform on the
// head's own branch. Op selects the operation; the remaining fields are
// op-specific (see each git.Guarded* helper for the exact semantics).
type Request struct {
	ReqID string `json:"reqid"`
	Op    Op     `json:"op,omitempty"`
	TS    string `json:"ts"`
	// ExpectedBranch/ExpectedHead snapshot the real checkout at request time for
	// a focused head. The daemon rejects the operation if another application
	// switches or advances the checkout before it executes.
	ExpectedBranch string `json:"expected_branch,omitempty"`
	ExpectedHead   string `json:"expected_head,omitempty"`

	// commit
	Message string   `json:"message,omitempty"`
	Paths   []string `json:"paths,omitempty"`
	Amend   bool     `json:"amend,omitempty"`
	Staged  bool     `json:"staged,omitempty"` // commit the index as-is, skipping the stage step

	// reset
	Mode    string   `json:"mode,omitempty"`    // soft | mixed | hard
	To      string   `json:"to,omitempty"`      // target commit-ish (e.g. "HEAD~1")
	Unstage []string `json:"unstage,omitempty"` // paths to unstage (reset -- <paths>)
	Confirm bool     `json:"confirm,omitempty"` // required for a destructive hard reset

	// add
	Add []AddSpec `json:"add,omitempty"`

	// revert / cherry_pick
	Commit string `json:"commit,omitempty"`

	// rebase
	Base string       `json:"base,omitempty"`
	Plan []RebaseStep `json:"plan,omitempty"`

	// merge (Message doubles as the merge-commit subject)
	Ref  string `json:"ref,omitempty"`   // the ref merged INTO the head's branch
	NoFF bool   `json:"no_ff,omitempty"` // force a merge commit even when it could fast-forward

	// stash (Message doubles as the stash label on push)
	Stash            string `json:"stash,omitempty"`             // push | pop | apply | list | drop
	StashRef         string `json:"stash_ref,omitempty"`         // "stash@{N}"; empty = the most recent
	IncludeUntracked bool   `json:"include_untracked,omitempty"` // stash push -u
}

// Result is the host's outcome for a Request: OK plus an agent-readable summary
// (e.g. the new commit's hash/subject) or an error explanation.
type Result struct {
	OK      bool   `json:"ok"`
	Message string `json:"message"`
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

// ListRequests returns the undecided requests in dir (those without a result
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
			continue // already decided
		}
		r, ok, err := ReadRequest(dir, reqid)
		if err != nil || !ok {
			continue
		}
		out = append(out, r)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].TS < out[j].TS })
	return out, nil
}

// ReadRequest reads the request <reqid>.req.json (ok=false if absent).
func ReadRequest(dir, reqid string) (Request, bool, error) {
	data, err := os.ReadFile(filepath.Join(dir, reqid+reqSuffix))
	if err != nil {
		if os.IsNotExist(err) {
			return Request{}, false, nil
		}
		return Request{}, false, errtrace.Wrap(err)
	}
	var r Request
	if err := json.Unmarshal(data, &r); err != nil {
		return Request{}, false, errtrace.Wrap(err)
	}
	return r, true, nil
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
