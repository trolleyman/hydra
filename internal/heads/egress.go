package heads

import (
	"log"
	"strconv"
	"sync"
	"time"

	"github.com/trolleyman/hydra/internal/api"
	"github.com/trolleyman/hydra/internal/egress"
	"github.com/trolleyman/hydra/internal/gate"
	"github.com/trolleyman/hydra/internal/paths"
	"github.com/trolleyman/hydra/internal/sandbox"
)

// EgressMode is the network-enforcement posture in effect for a head, surfaced to
// the UI so the user knows how strong the boundary is.
type EgressMode string

const (
	// EgressNone is the zero value: no mode recorded for the head (not live, or
	// never started). The API omits it.
	EgressNone EgressMode = ""
	// EgressUnrestricted: network on with host filtering off → every host
	// reachable. Surfaced so the user can see a head has an open egress channel.
	EgressUnrestricted EgressMode = "unrestricted"
	// EgressOff: network disabled entirely (the hard off-switch).
	EgressOff EgressMode = "off"
	// EgressHard: allow-list enforced in a pasta netns + nft lock — a real,
	// inescapable boundary.
	EgressHard EgressMode = "filtered-hard"
	// EgressAdvisory: allow-list enforced by the proxy via HTTP(S)_PROXY only —
	// filters every proxy-respecting client, but a determined process in the
	// shared net namespace can bypass it (pasta/nft unavailable on this host).
	EgressAdvisory EgressMode = "filtered-advisory"
)

// egressEntry is a head's running proxy plus its mode.
type egressEntry struct {
	proxy *egress.Proxy
	mode  EgressMode
}

var egressProxies = struct {
	mu sync.Mutex
	m  map[string]*egressEntry
}{m: map[string]*egressEntry{}}

// startEgress sets up a head's egress filtering from its resolved network policy
// and returns the proxy env to inject plus, for hard mode, the bwrap-wrapping
// closure to put on sandbox.Options.EgressWrap. It may set net.Enabled = false
// (via the pointer) when a strict hard policy can't build its boundary, so the
// sandbox falls back to no network at all.
//
//   - mode off / !Enabled → no proxy, no network.
//   - mode unrestricted → no proxy, unrestricted egress.
//   - mode advisory → proxy-only filtering (escapable), no hard boundary attempted.
//   - mode hard → attempt the pasta+nft netns (inescapable); if the tooling is
//     unavailable, degrade to advisory with a warning, unless Strict, in which
//     case fail closed (no network).
//
// The proxy enforces the effective allow-list — the built-in DefaultAllowedHosts
// unioned with net.AllowedHosts — minus net.BlockedHosts, which overrides it.
func startEgress(projectRoot, id string, net *sandbox.NetworkPolicy) (env []string, wrap func([]string, string) []string) {
	stopEgressProxy(id)
	if !net.Enabled || net.Mode == sandbox.NetOff {
		setEgressMode(id, EgressOff)
		return nil, nil
	}
	if !net.FilterHosts || net.Mode == sandbox.NetUnrestricted {
		setEgressMode(id, EgressUnrestricted)
		return nil, nil
	}

	allowed := append(sandbox.DefaultAllowedHosts(), net.AllowedHosts...)
	approver := &egressApprover{projectRoot: projectRoot, id: id}
	p, err := egress.Start(id, allowed, net.BlockedHosts, approver.approve)
	if err != nil {
		if net.Mode == sandbox.NetHard && net.Strict {
			log.Printf("hydra egress[%s]: STRICT hard egress but proxy failed to start; failing closed (no network): %v", id, err)
			net.Enabled = false
			setEgressMode(id, EgressOff)
			return nil, nil
		}
		log.Printf("hydra egress[%s]: could not start filtering proxy, continuing WITHOUT host filtering: %v", id, err)
		setEgressMode(id, EgressUnrestricted)
		return nil, nil
	}
	port := egress.HostPort(p.Addr())

	if net.Mode == sandbox.NetHard {
		if hm := egress.DetectHardMode(); hm.Available && port != 0 {
			// Hard mode: the agent reaches the host proxy at the mapped address, and
			// nft drops everything else. The proxy itself listens on host loopback.
			storeEgress(id, p, EgressHard)
			proxyURL := "http://" + egress.MapAddr + ":" + itoa(port)
			log.Printf("hydra egress[%s]: hard egress boundary active (pasta+nft), %d allow-listed host(s); agent proxy=%s (host listener %s)", id, len(allowed), proxyURL, p.Addr())
			env = egress.ProxyEnv(proxyURL)
			wrap = func(bwrapArgv []string, preExec string) []string {
				return egress.HardWrapArgv(hm, port, bwrapArgv, preExec)
			}
			return env, wrap
		}
		if net.Strict {
			// Strict: no inescapable boundary available → fail closed.
			log.Printf("hydra egress[%s]: STRICT hard egress requested but pasta/nft unavailable; failing closed (no network)", id)
			_ = p.Close()
			net.Enabled = false
			setEgressMode(id, EgressOff)
			return nil, nil
		}
		log.Printf("hydra egress[%s]: hard egress requested but pasta/nft unavailable; DEGRADED to advisory filtering", id)
	}

	// Advisory mode (chosen, or a non-strict hard degrade): shared host net, proxy
	// reachable on loopback, filtering via HTTP(S)_PROXY only.
	storeEgress(id, p, EgressAdvisory)
	log.Printf("hydra egress[%s]: advisory egress filtering (proxy only), %d allow-listed host(s)", id, len(allowed))
	return egress.ProxyEnv("http://" + p.Addr()), nil
}

// EgressModeFor returns the enforcement mode currently recorded for a head (used
// by the API/UI). Unknown heads report EgressNone.
func EgressModeFor(id string) EgressMode {
	egressProxies.mu.Lock()
	defer egressProxies.mu.Unlock()
	if e := egressProxies.m[id]; e != nil {
		return e.mode
	}
	return EgressNone
}

func storeEgress(id string, p *egress.Proxy, mode EgressMode) {
	egressProxies.mu.Lock()
	egressProxies.m[id] = &egressEntry{proxy: p, mode: mode}
	egressProxies.mu.Unlock()
}

// setEgressMode records a mode with no running proxy (off / unrestricted).
func setEgressMode(id string, mode EgressMode) {
	egressProxies.mu.Lock()
	egressProxies.m[id] = &egressEntry{mode: mode}
	egressProxies.mu.Unlock()
}

// stopEgressProxy closes and forgets a head's egress proxy, if any.
func stopEgressProxy(id string) {
	egressProxies.mu.Lock()
	e := egressProxies.m[id]
	delete(egressProxies.m, id)
	egressProxies.mu.Unlock()
	if e != nil && e.proxy != nil {
		_ = e.proxy.Close()
	}
}

// egressApprovalTimeout bounds how long a blocked outbound connection waits for a
// user decision before it is denied (matching the security gate's ask timeout —
// see internal/cli/gate.go). On timeout the agent gets the same 403 it would have
// gotten under a silent deny, just after giving the user a chance to approve.
const egressApprovalTimeout = 5 * time.Minute

// egressApprovalPoll is how often the approver re-checks for a decision file.
const egressApprovalPoll = 500 * time.Millisecond

// egressApprover parks an agent for user approval when its egress proxy hits a
// host that is on neither the allow- nor the block-list. It reuses the
// security-gate approval channel: it writes a request the web UI surfaces as an
// approval toast (the same mechanism as a parked MCP/WebFetch call) and polls for
// the decision the UI writes back. While any host is pending it flips the head's
// status to a policy-approval wait so the toast appears, restoring "running" once
// the last pending host resolves.
//
// It runs on the host (inside the daemon), so unlike the in-sandbox `hydra gate`
// hook it talks to the status/approval files directly rather than over env-var
// paths. A granted host is added to the proxy's live allow-list by the proxy
// itself; "always allow" additionally persists it to the project config via the
// API's remember path (internal/http/approvals.go).
type egressApprover struct {
	projectRoot string
	id          string
	mu          sync.Mutex
	active      int // hosts currently parked; the last to resolve clears the wait
}

// approve is the egress.ApproveFunc: it blocks until the user decides (or the
// timeout/cancel fires), returning whether the connection to host may proceed.
func (e *egressApprover) approve(host string, cancel <-chan struct{}) bool {
	if e.projectRoot == "" {
		return false // no channel to ask over (e.g. tests) → deny, as before
	}
	dir := paths.GetApprovalsDirFromProjectRoot(e.projectRoot, e.id)
	reqid := "egress-" + strconv.FormatInt(time.Now().UnixNano(), 10)
	summary := "wants to connect to " + strconv.Quote(host)
	req := gate.Request{
		ReqID:   reqid,
		Tool:    "egress",
		Kind:    "egress",
		Target:  host,
		Reason:  "egress to " + strconv.Quote(host) + " is not on the network allow-list",
		Summary: summary,
		TS:      time.Now().Format(time.RFC3339Nano),
	}
	if err := gate.WriteRequest(dir, req); err != nil {
		log.Printf("hydra egress[%s]: write approval request for %q: %v", e.id, host, err)
		return false
	}

	e.enter(summary)
	defer e.leave()
	defer gate.RemoveRequest(dir, reqid)

	deadline := time.Now().Add(egressApprovalTimeout)
	for {
		if d, ok, err := gate.ReadDecision(dir, reqid); err == nil && ok {
			return d.Decision == gate.Allow
		}
		if time.Now().After(deadline) {
			log.Printf("hydra egress[%s]: approval for %q timed out; denying", e.id, host)
			return false
		}
		select {
		case <-cancel:
			return false
		case <-time.After(egressApprovalPoll):
		}
	}
}

// enter records a newly-parked host and flips the head into a policy-approval wait
// so the UI surfaces the approval toast.
func (e *egressApprover) enter(summary string) {
	e.mu.Lock()
	e.active++
	e.mu.Unlock()
	e.writeApprovalStatus(summary)
}

// leave drops a resolved host; when it was the last pending one it restores the
// head to "running" so the wait (and its toast) clears.
func (e *egressApprover) leave() {
	e.mu.Lock()
	e.active--
	last := e.active <= 0
	e.mu.Unlock()
	if last {
		e.restoreRunning()
	}
}

// writeApprovalStatus flips status.json to a needs-input policy-approval wait. The
// timestamp advance is what the JSON poller keys on to notice the change.
func (e *egressApprover) writeApprovalStatus(summary string) {
	nt := gate.NotificationPolicyApproval
	msg := summary
	_ = WriteAgentStatus(e.projectRoot, e.id, &api.AgentStatusInfo{
		Status:           api.NeedsInput,
		Timestamp:        time.Now().Format(time.RFC3339Nano),
		LastMessage:      &msg,
		NotificationType: &nt,
	})
}

// restoreRunning clears the policy-approval wait, but only if it still owns the
// status (nothing newer — e.g. the agent's own hook — has moved it on).
func (e *egressApprover) restoreRunning() {
	if s := ReadAgentStatus(e.projectRoot, e.id); s != nil &&
		(s.NotificationType == nil || *s.NotificationType != gate.NotificationPolicyApproval) {
		return
	}
	_ = WriteAgentStatus(e.projectRoot, e.id, &api.AgentStatusInfo{
		Status:    api.Running,
		Timestamp: time.Now().Format(time.RFC3339Nano),
	})
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b [20]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	return string(b[i:])
}
