package gate

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"braces.dev/errtrace"
)

// The "ask" round-trip uses a per-head approval directory that is the agent's
// real host path made writable inside the sandbox (the same mechanism as
// status.json). The in-sandbox hook writes a <reqid>.req.json and polls for a
// <reqid>.decision.json; the host-side daemon/API reads pending requests and
// writes decisions. The daemon socket itself is unreachable in-sandbox (HardenGUI
// tmpfs's XDG_RUNTIME_DIR), so this file channel is how the gate and the UI talk.
const (
	reqSuffix      = ".req.json"
	decisionSuffix = ".decision.json"
)

// Request is one pending approval the gate parked. It is surfaced in the web UI
// approval card and carries what a remembered approval needs to persist.
type Request struct {
	ReqID   string `json:"reqid"`
	Tool    string `json:"tool"`
	Kind    string `json:"kind"`   // mcp | webfetch | bash
	Target  string `json:"target"` // server name / host / "git push"
	Reason  string `json:"reason"`
	Summary string `json:"summary"`
	TS      string `json:"ts"`
}

// DecisionFile is the verdict the UI writes back for a parked Request.
type DecisionFile struct {
	Decision Decision `json:"decision"` // allow | deny
	Remember bool     `json:"remember"`
}

// WriteRequest writes r as <reqid>.req.json into dir (created if needed).
func WriteRequest(dir string, r Request) error {
	if err := os.MkdirAll(dir, 0755); err != nil {
		return errtrace.Wrap(err)
	}
	data, err := json.MarshalIndent(r, "", "  ")
	if err != nil {
		return errtrace.Wrap(err)
	}
	return errtrace.Wrap(os.WriteFile(filepath.Join(dir, r.ReqID+reqSuffix), data, 0644))
}

// ListRequests returns the pending (undecided) approval requests in dir, oldest
// first. A request whose decision file already exists is omitted. A missing dir
// is not an error (no pending requests).
func ListRequests(dir string) ([]Request, error) {
	entries, err := os.ReadDir(dir)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	var out []Request
	for _, e := range entries {
		name := e.Name()
		if !strings.HasSuffix(name, reqSuffix) {
			continue
		}
		reqid := strings.TrimSuffix(name, reqSuffix)
		if _, err := os.Stat(filepath.Join(dir, reqid+decisionSuffix)); err == nil {
			continue // already decided
		}
		data, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			continue
		}
		var r Request
		if json.Unmarshal(data, &r) == nil {
			out = append(out, r)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].TS < out[j].TS })
	return out, nil
}

// ReadRequest returns the parked request reqid in dir, or ok=false if absent.
func ReadRequest(dir, reqid string) (Request, bool, error) {
	data, err := os.ReadFile(filepath.Join(dir, reqid+reqSuffix))
	if os.IsNotExist(err) {
		return Request{}, false, nil
	}
	if err != nil {
		return Request{}, false, errtrace.Wrap(err)
	}
	var r Request
	if err := json.Unmarshal(data, &r); err != nil {
		return Request{}, false, errtrace.Wrap(err)
	}
	return r, true, nil
}

// ReadDecision returns the decision for reqid in dir, or ok=false if none yet.
func ReadDecision(dir, reqid string) (DecisionFile, bool, error) {
	data, err := os.ReadFile(filepath.Join(dir, reqid+decisionSuffix))
	if os.IsNotExist(err) {
		return DecisionFile{}, false, nil
	}
	if err != nil {
		return DecisionFile{}, false, errtrace.Wrap(err)
	}
	var d DecisionFile
	if err := json.Unmarshal(data, &d); err != nil {
		return DecisionFile{}, false, errtrace.Wrap(err)
	}
	return d, true, nil
}

// WriteDecision records the UI's verdict for reqid in dir.
func WriteDecision(dir, reqid string, d DecisionFile) error {
	if err := os.MkdirAll(dir, 0755); err != nil {
		return errtrace.Wrap(err)
	}
	data, err := json.MarshalIndent(d, "", "  ")
	if err != nil {
		return errtrace.Wrap(err)
	}
	return errtrace.Wrap(os.WriteFile(filepath.Join(dir, reqid+decisionSuffix), data, 0644))
}
