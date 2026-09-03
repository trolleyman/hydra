package gate

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"

	"braces.dev/errtrace"
)

var readableGrantsMu sync.Mutex

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
	// grantedHostsFile holds hosts the user allowed during the current session, via
	// either a WebFetch gate card or an egress card (both "allow" and "always
	// allow" - a persistent grant additionally lands in the project config,
	// effective next launch). It is the one session grant store BOTH network
	// layers consult: the in-sandbox gate hook unions it into the read-only seeded
	// policy.json, and the egress approver checks it before parking a connection -
	// so a single allow covers the tool-level and connection-level prompts. It
	// lives in the per-head approvals dir and is removed with it when the head is
	// killed (RemoveAgentStatusFiles).
	grantedHostsFile = "granted-hosts.json"
	// grantedReadablePathsFile holds exact, host-canonical paths approved for this
	// head's current lifetime. Unlike network grants, a filesystem grant cannot be
	// applied live: the daemon reads this overlay while rebuilding the sandbox.
	// The approvals directory is removed when the head is killed or archived, so
	// an "allow once" grant does not leak into a later head.
	grantedReadablePathsFile = "granted-readable-paths.json"
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

// AddGrantedHost appends host to the session's live host grant list (creating
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

// LoadGrantedReadablePaths returns host paths approved for this head's current
// lifetime. A missing or malformed file yields no paths.
func LoadGrantedReadablePaths(dir string) []string {
	data, err := os.ReadFile(GrantedReadablePathsPath(dir))
	if err != nil {
		return nil
	}
	var paths []string
	if json.Unmarshal(data, &paths) != nil {
		return nil
	}
	return paths
}

// GrantedReadablePathsPath returns the host-side grant store path. Sandboxes
// mask this exact file after binding the otherwise writable approval directory,
// so only the daemon can add capabilities to it.
func GrantedReadablePathsPath(dir string) string {
	return filepath.Join(dir, grantedReadablePathsFile)
}

// EnsureGrantedReadablePathsFile creates the host-only grant store before the
// sandbox is built, allowing the sandbox policy to mask a concrete file.
func EnsureGrantedReadablePathsFile(dir string) error {
	readableGrantsMu.Lock()
	defer readableGrantsMu.Unlock()
	return errtrace.Wrap(ensureGrantedReadablePathsFile(dir))
}

func ensureGrantedReadablePathsFile(dir string) error {
	if err := os.MkdirAll(dir, 0755); err != nil {
		return errtrace.Wrap(err)
	}
	root, err := os.OpenRoot(dir)
	if err != nil {
		return errtrace.Wrap(err)
	}
	defer root.Close()
	if info, err := root.Lstat(grantedReadablePathsFile); err == nil {
		if !info.Mode().IsRegular() {
			return errtrace.Errorf("readable grant store is not a regular file")
		}
		file, err := root.OpenFile(grantedReadablePathsFile, os.O_RDWR, 0)
		if err != nil {
			return errtrace.Wrap(err)
		}
		defer file.Close()
		return errtrace.Wrap(file.Chmod(0600))
	} else if !os.IsNotExist(err) {
		return errtrace.Wrap(err)
	}
	file, err := root.OpenFile(grantedReadablePathsFile, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return errtrace.Wrap(err)
	}
	if _, err := file.Write([]byte("[]\n")); err != nil {
		_ = file.Close()
		return errtrace.Wrap(err)
	}
	return errtrace.Wrap(file.Close())
}

// AddGrantedReadablePath appends a canonical host path to the current head's
// live grant overlay, deduplicating with the host platform's path spelling.
func AddGrantedReadablePath(dir, path string) error {
	readableGrantsMu.Lock()
	defer readableGrantsMu.Unlock()
	if err := ensureGrantedReadablePathsFile(dir); err != nil {
		return errtrace.Wrap(err)
	}
	path = filepath.Clean(strings.TrimSpace(path))
	if path == "." || path == "" {
		return nil
	}
	root, err := os.OpenRoot(dir)
	if err != nil {
		return errtrace.Wrap(err)
	}
	defer root.Close()
	data, err := root.ReadFile(grantedReadablePathsFile)
	if err != nil {
		return errtrace.Wrap(err)
	}
	var paths []string
	if err := json.Unmarshal(data, &paths); err != nil {
		return errtrace.Wrap(err)
	}
	for _, existing := range paths {
		if filepath.Clean(existing) == path {
			return nil
		}
	}
	paths = append(paths, path)
	data, err = json.MarshalIndent(paths, "", "  ")
	if err != nil {
		return errtrace.Wrap(err)
	}
	data = append(data, '\n')
	tmp, tmpName, err := createRootTemp(root, ".readable-grants-")
	if err != nil {
		return errtrace.Wrap(err)
	}
	defer root.Remove(tmpName)
	if err := tmp.Chmod(0600); err != nil {
		_ = tmp.Close()
		return errtrace.Wrap(err)
	}
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		return errtrace.Wrap(err)
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return errtrace.Wrap(err)
	}
	if err := tmp.Close(); err != nil {
		return errtrace.Wrap(err)
	}
	if info, err := root.Lstat(grantedReadablePathsFile); err != nil || !info.Mode().IsRegular() {
		return errtrace.Errorf("readable grant store is not a regular file")
	}
	return errtrace.Wrap(root.Rename(tmpName, grantedReadablePathsFile))
}

func createRootTemp(root *os.Root, prefix string) (*os.File, string, error) {
	for range 100 {
		var random [8]byte
		if _, err := rand.Read(random[:]); err != nil {
			return nil, "", errtrace.Wrap(err)
		}
		name := prefix + hex.EncodeToString(random[:])
		file, err := root.OpenFile(name, os.O_RDWR|os.O_CREATE|os.O_EXCL, 0600)
		if err == nil {
			return file, name, nil
		}
		if !os.IsExist(err) {
			return nil, "", errtrace.Wrap(err)
		}
	}
	return nil, "", errtrace.Errorf("could not allocate temporary grant file")
}

// Request is one pending approval the gate parked. It is surfaced in the web UI
// approval card and carries what a remembered approval needs to persist.
type Request struct {
	ReqID   string `json:"reqid"`
	Tool    string `json:"tool"`
	Kind    string `json:"kind"`   // mcp | mcp_tool | webfetch | egress | bash | host_command | filesystem_read
	Target  string `json:"target"` // server / "<server>__<tool>" / host / command / host path
	Reason  string `json:"reason"`
	Summary string `json:"summary"`
	// RW is the read/write classification of an mcp_tool request ("read"/"write"/""),
	// surfaced as a badge in the approval UI.
	RW string `json:"rw,omitempty"`
	// URL is the full request URL for a webfetch request (previewed in the card).
	URL string `json:"url,omitempty"`
	// ArgsPreview is a compact one-line preview of an mcp_tool call's arguments.
	ArgsPreview string `json:"args_preview,omitempty"`
	// Description is the agent's own explanation of what it is asking for and why
	// it needs to happen outside the sandbox (`host-run --why`). Shown in the
	// approval card and toast above the command, so the user is judging a stated
	// intent rather than reverse-engineering one from a shell script.
	Description string `json:"description,omitempty"`
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
