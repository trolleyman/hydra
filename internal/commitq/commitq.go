// Package commitq is the file-channel the in-sandbox git_commit tool uses to have
// the daemon perform a commit on its behalf, for the readonly git-isolation mode
// where .git is read-only in the sandbox (so an in-sandbox commit can't write it).
// It mirrors the gate approval channel: the sandbox writes a
// request file into a per-head writable dir and polls for a result file the host
// writes back; the daemon can't be reached over its socket from inside the box.
//
// One request per file, keyed by a caller-chosen reqid: <reqid>.commit.json holds
// the Request, <reqid>.result.json the Result. A request with a result file is
// "done" and skipped by ListRequests (the idempotency the watcher relies on).
package commitq

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"braces.dev/errtrace"
)

const (
	reqSuffix    = ".commit.json"
	resultSuffix = ".result.json"
)

// Request is a commit the sandbox asks the host to perform on the head's own
// branch: stage `Paths` (all changes when empty) and commit with `Message`.
type Request struct {
	ReqID   string   `json:"reqid"`
	Message string   `json:"message"`
	Paths   []string `json:"paths,omitempty"`
	Amend   bool     `json:"amend,omitempty"`
	TS      string   `json:"ts"`
}

// Result is the host's outcome for a Request: OK plus an agent-readable summary
// (the new commit's hash/subject) or an error explanation.
type Result struct {
	OK      bool   `json:"ok"`
	Message string `json:"message"`
}

// WriteRequest writes r into dir as <reqid>.commit.json (creating dir).
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

// ReadRequest reads the request <reqid>.commit.json (ok=false if absent).
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
