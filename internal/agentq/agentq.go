// Package agentq is the file channel a sandboxed head uses to discover and
// message other heads through the daemon. The per-head directory identifies the
// source; callers never supply or impersonate it.
package agentq

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

type Op string

const (
	OpList    Op = "list"
	OpGet     Op = "get"
	OpMessage Op = "message"
)

type Request struct {
	ReqID         string `json:"reqid"`
	TS            string `json:"ts"`
	Op            Op     `json:"op"`
	Target        string `json:"target,omitempty"`
	Body          string `json:"body,omitempty"`
	CorrelationID string `json:"correlation_id,omitempty"`
	InReplyTo     string `json:"in_reply_to,omitempty"`
}

type Result struct {
	OK      bool   `json:"ok"`
	Message string `json:"message,omitempty"`
}

func WriteRequest(dir string, r Request) error {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return errtrace.Wrap(err)
	}
	b, err := json.Marshal(r)
	if err != nil {
		return errtrace.Wrap(err)
	}
	return errtrace.Wrap(os.WriteFile(filepath.Join(dir, r.ReqID+reqSuffix), b, 0o644))
}

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
		if !strings.HasSuffix(e.Name(), reqSuffix) {
			continue
		}
		reqid := strings.TrimSuffix(e.Name(), reqSuffix)
		if _, err := os.Stat(filepath.Join(dir, reqid+resultSuffix)); err == nil {
			continue
		}
		b, err := os.ReadFile(filepath.Join(dir, e.Name()))
		if err != nil {
			continue
		}
		var r Request
		if json.Unmarshal(b, &r) == nil {
			// The filename is the request identity. Never trust the JSON field: the
			// sandbox can hand-write a request, and a forged ../../ reqid must not
			// steer the daemon's result write outside this channel.
			r.ReqID = reqid
			out = append(out, r)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].TS < out[j].TS })
	return out, nil
}

func WriteResult(dir, reqid string, r Result) error {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return errtrace.Wrap(err)
	}
	b, err := json.Marshal(r)
	if err != nil {
		return errtrace.Wrap(err)
	}
	return errtrace.Wrap(os.WriteFile(filepath.Join(dir, reqid+resultSuffix), b, 0o644))
}

func ReadResult(dir, reqid string) (Result, bool, error) {
	b, err := os.ReadFile(filepath.Join(dir, reqid+resultSuffix))
	if err != nil {
		if os.IsNotExist(err) {
			return Result{}, false, nil
		}
		return Result{}, false, errtrace.Wrap(err)
	}
	var r Result
	if err := json.Unmarshal(b, &r); err != nil {
		return Result{}, false, errtrace.Wrap(err)
	}
	return r, true, nil
}

func Sweep(dir string, keep int) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	var done []string
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), resultSuffix) {
			done = append(done, strings.TrimSuffix(e.Name(), resultSuffix))
		}
	}
	if len(done) <= keep {
		return
	}
	sort.Strings(done)
	for _, reqid := range done[:len(done)-keep] {
		_ = os.Remove(filepath.Join(dir, reqid+reqSuffix))
		_ = os.Remove(filepath.Join(dir, reqid+resultSuffix))
	}
}
