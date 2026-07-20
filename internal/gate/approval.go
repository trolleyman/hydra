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
	// resultSuffix carries a host-run command's outcome back into the sandbox: the
	// daemon executes an approved host_command request host-side and writes
	// <reqid>.result.json; the blocked `hydra host-run` CLI polls for it and relays
	// output + exit code to the agent.
	resultSuffix = ".result.json"
	// grantedHostsFile holds hosts the user "always allow"ed for WebFetch during the
	// current session. The persistent grant lands in the project config (effective
	// next launch), but the running head's seeded policy.json is read-only, so this
	// writable file in the approval dir is how a mid-session grant reaches the
	// in-sandbox gate without a relaunch.
	grantedHostsFile = "granted-hosts.json"
)

// LoadGrantedHosts returns the hosts granted live for this session (see
// grantedHostsFile). A missing/unreadable file yields no hosts.
func LoadGrantedHosts(dir string) []string {
	data, err := os.ReadFile(filepath.Join(dir, grantedHostsFile))
	if err != nil {
		return nil
	}
	var hosts []string
	if json.Unmarshal(data, &hosts) != nil {
		return nil
	}
	return hosts
}

// AddGrantedHost appends host to the session's live WebFetch grant list (creating
// the file if needed), deduplicating case-insensitively.
func AddGrantedHost(dir, host string) error {
	if err := os.MkdirAll(dir, 0755); err != nil {
		return errtrace.Wrap(err)
	}
	host = strings.ToLower(strings.TrimSpace(host))
	if host == "" {
		return nil
	}
	hosts := LoadGrantedHosts(dir)
	for _, h := range hosts {
		if strings.EqualFold(h, host) {
			return nil
		}
	}
	hosts = append(hosts, host)
	data, err := json.MarshalIndent(hosts, "", "  ")
	if err != nil {
		return errtrace.Wrap(err)
	}
	return errtrace.Wrap(os.WriteFile(filepath.Join(dir, grantedHostsFile), data, 0644))
}

// Request is one pending approval the gate parked. It is surfaced in the web UI
// approval card and carries what a remembered approval needs to persist.
type Request struct {
	ReqID   string `json:"reqid"`
	Tool    string `json:"tool"`
	Kind    string `json:"kind"`   // mcp | mcp_tool | webfetch | egress | bash | host_command
	Target  string `json:"target"` // server name / "<server>__<tool>" / host / command text
	Reason  string `json:"reason"`
	Summary string `json:"summary"`
	// RW is the read/write classification of an mcp_tool request ("read"/"write"/""),
	// surfaced as a badge in the approval UI.
	RW string `json:"rw,omitempty"`
	// URL is the full request URL for a webfetch request (previewed in the card).
	URL string `json:"url,omitempty"`
	// ArgsPreview is a compact one-line preview of an mcp_tool call's arguments.
	ArgsPreview string `json:"args_preview,omitempty"`
	TS          string `json:"ts"`
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

// RemoveRequest deletes the request and any decision/result file for reqid in
// dir, used to retire a resolved approval so it stops being surfaced.
// Best-effort: missing files are not an error.
func RemoveRequest(dir, reqid string) {
	_ = os.Remove(filepath.Join(dir, reqid+reqSuffix))
	_ = os.Remove(filepath.Join(dir, reqid+decisionSuffix))
	_ = os.Remove(filepath.Join(dir, reqid+resultSuffix))
}

// HostRunResult is the outcome of an approved host_command, written host-side by
// the daemon and read in-sandbox by `hydra host-run`.
type HostRunResult struct {
	ExitCode int    `json:"exit_code"`
	Output   string `json:"output"` // combined stdout+stderr, tail-capped
	// Truncated is set when Output was capped to its final bytes.
	Truncated bool `json:"truncated,omitempty"`
	// TimedOut is set when the command was killed at the execution deadline.
	TimedOut bool `json:"timed_out,omitempty"`
	// Error describes a failure to run the command at all (as opposed to the
	// command running and exiting non-zero).
	Error string `json:"error,omitempty"`
}

// WriteHostRunResult records the outcome of an approved host_command for reqid.
func WriteHostRunResult(dir, reqid string, r HostRunResult) error {
	if err := os.MkdirAll(dir, 0755); err != nil {
		return errtrace.Wrap(err)
	}
	data, err := json.MarshalIndent(r, "", "  ")
	if err != nil {
		return errtrace.Wrap(err)
	}
	return errtrace.Wrap(os.WriteFile(filepath.Join(dir, reqid+resultSuffix), data, 0644))
}

// ReadHostRunResult returns the host-run result for reqid, or ok=false if the
// daemon hasn't written one yet.
func ReadHostRunResult(dir, reqid string) (HostRunResult, bool, error) {
	data, err := os.ReadFile(filepath.Join(dir, reqid+resultSuffix))
	if os.IsNotExist(err) {
		return HostRunResult{}, false, nil
	}
	if err != nil {
		return HostRunResult{}, false, errtrace.Wrap(err)
	}
	var r HostRunResult
	if err := json.Unmarshal(data, &r); err != nil {
		return HostRunResult{}, false, errtrace.Wrap(err)
	}
	return r, true, nil
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
