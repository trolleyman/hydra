package heads

import (
	"log"
	"strconv"
	"sync"
	"time"

	"github.com/trolleyman/hydra/internal/api"
	"github.com/trolleyman/hydra/internal/config"
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
	// EgressHard: allow-list enforced by the platform sandbox around the proxy -
	// pasta+nft on Linux, loopback-only Seatbelt networking on Darwin.
	EgressHard EgressMode = "filtered-hard"
	// EgressAdvisory: allow-list enforced by the proxy via HTTP(S)_PROXY only -
	// filters every proxy-respecting client, but a determined process in the
	// shared net namespace can bypass it (pasta/nft unavailable on this host).
	EgressAdvisory EgressMode = "filtered-advisory"
)

// egressEntry is a head's running proxy plus its mode.
type egressEntry struct {
	proxy    *egress.Proxy
	mode     EgressMode
	proxyURL string
}

var egressProxies = struct {
	mu sync.Mutex
	m  map[string]*egressEntry
}{m: map[string]*egressEntry{}}

// startEgress sets up a head's egress filtering from its resolved network policy
// and returns the proxy env to inject plus, for hard mode, the bwrap-wrapping
// closure to put on sandbox.Options.EgressWrap where the platform needs one. It
// may set net.Enabled = false when a hard policy cannot build its boundary, so
// the sandbox falls back to no network at all.
//
//   - mode off / !Enabled → no proxy, no network.
//   - mode unrestricted → no proxy, unrestricted egress.
//   - mode advisory → proxy-only filtering (escapable), no hard boundary attempted.
//   - mode hard → the platform kernel boundary (inescapable); if it cannot be
//     built (tooling unavailable, proxy failed) it fails closed (no network) -
//     hard never downgrades to a weaker posture.
//
// The proxy enforces the effective allow-list - the built-in DefaultAllowedHosts
// unioned with net.AllowedHosts - minus net.BlockedHosts, which overrides it.
func startEgress(projectRoot, id string, agentType sandbox.AgentType, net *sandbox.NetworkPolicy) (env []string, wrap func([]string, string) []string) {
	return startEgressKeyed(projectRoot, id, id, agentType, net)
}

// startEgressKeyed is startEgress with the proxy lifecycle keyed by `id` but the
// user-approval channel (the needs-input status toast and the approvals dir a
// parked host waits on) keyed by `approvalID`. For an agent the two are the same
// head id. They differ for a head's standalone sandboxed bash shell: the proxy is
// keyed by the ephemeral shell id (its own netns, own port, torn down with the tab
// via StopShellEgress) while approvals still surface on the head's agent card
// (approvalID = head id), since the shell has no card of its own.
func startEgressKeyed(projectRoot, id, approvalID string, agentType sandbox.AgentType, net *sandbox.NetworkPolicy) (env []string, wrap func([]string, string) []string) {
	stopEgressProxy(id)
	if !net.Enabled || net.Mode == sandbox.NetOff {
		setEgressMode(id, EgressOff)
		return nil, nil
	}
	if !net.FilterHosts || net.Mode == sandbox.NetUnrestricted {
		setEgressMode(id, EgressUnrestricted)
		return nil, nil
	}

	allowed := append(sandbox.DefaultAllowedHosts(agentType), net.AllowedHosts...)
	approver := &egressApprover{projectRoot: projectRoot, id: approvalID, agentType: agentType}
	// Pin the proxy to the port the head's hard boundary already allows. If a
	// supervisor is live on resume/restart, its nft rule (Linux) or Seatbelt
	// profile (Darwin) still contains the port baked at first launch, so the proxy
	// must return on that port. A first spawn binds a fresh ephemeral port which is
	// then baked into the supervisor built moments later.
	fixedPort := 0
	if _, live := namespaceHostFor(id); live {
		fixedPort = rememberedEgressPort(id)
		if fixedPort == 0 {
			log.Printf("hydra egress[%s]: supervisor already live but no remembered proxy port; a newly allocated port may desync the hard boundary", id)
		}
	}
	p, err := egress.Start(id, fixedPort, allowed, net.BlockedHosts, approver.approve)
	if err != nil && fixedPort != 0 {
		// Couldn't reclaim the baked port; fall back to a fresh one so the head at
		// least keeps a proxy, and make the (now likely) firewall desync visible
		// rather than silent. A full head restart clears it.
		log.Printf("hydra egress[%s]: could not re-bind proxy to netns-allowed port %d; falling back to a fresh port (egress may stay blocked until the head is fully restarted): %v", id, fixedPort, err)
		p, err = egress.Start(id, 0, allowed, net.BlockedHosts, approver.approve)
	}
	if err != nil {
		if net.Mode == sandbox.NetHard {
			log.Printf("hydra egress[%s]: hard egress but proxy failed to start; failing closed (no network): %v", id, err)
			net.Enabled = false
			setEgressMode(id, EgressOff)
			return nil, nil
		}
		log.Printf("hydra egress[%s]: could not start filtering proxy, continuing WITHOUT host filtering: %v", id, err)
		setEgressMode(id, EgressUnrestricted)
		return nil, nil
	}
	port := egress.HostPort(p.Addr())
	// Remember the bound port for the supervisor's lifetime so any later relaunch
	// re-binds it (see egressPorts). Cleared by forgetEgressPort on teardown.
	setEgressPort(id, port)

	if net.Mode == sandbox.NetHard {
		if boundary, ok := egress.PrepareHardBoundary(id, port, net, 0); ok {
			storeEgress(id, p, EgressHard, boundary.ProxyURL)
			log.Printf("hydra egress[%s]: hard egress boundary active (%s), %d allow-listed host(s); agent proxy=%s (host listener %s); allowed loopback ports: %v", id, boundary.Mechanism, len(allowed), boundary.ProxyURL, p.Addr(), net.AllowedLoopbackPorts)
			return egress.ProxyEnv(boundary.ProxyURL), boundary.Wrap
		}
		// No inescapable boundary available → fail closed. Hard never degrades
		// to the escapable advisory posture.
		log.Printf("hydra egress[%s]: hard egress requested but the platform boundary is unavailable; failing closed (no network)", id)
		_ = p.Close()
		net.Enabled = false
		setEgressMode(id, EgressOff)
		return nil, nil
	}

	// Advisory mode (explicitly chosen): shared host net, proxy reachable on
	// loopback, filtering via HTTP(S)_PROXY only.
	storeEgress(id, p, EgressAdvisory, "http://"+p.Addr())
	log.Printf("hydra egress[%s]: advisory egress filtering (proxy only), %d allow-listed host(s)", id, len(allowed))
	return egress.ProxyEnv("http://" + p.Addr()), nil
}

// EgressProxyEnvFor returns the HTTP(S)_PROXY environment a co-tenant process -
// e.g. an interactive bash shell sharing the head's sandbox - must set to reach
// the network through the head's ALREADY-RUNNING egress proxy. It does NOT start,
// stop, or rebuild anything (unlike startEgress); it only reflects the proxy the
// agent's spawn/resume put in place.
//
// This matters most in hard mode: the kernel boundary drops all IP egress except
// TCP to the proxy (plus configured loopback ports), so a process without
// HTTP_PROXY cannot reach an external host or trigger the proxy's approval flow.
// A sibling bash tab therefore needs the same proxy environment as the agent.
//
// Returns nil when the head has no filtering proxy running (off / unrestricted /
// none live), where a co-tenant either needs no proxy or has no network at all.
func EgressProxyEnvFor(id string) []string {
	egressProxies.mu.Lock()
	e := egressProxies.m[id]
	egressProxies.mu.Unlock()
	if e == nil || e.proxy == nil {
		return nil
	}
	switch e.mode {
	case EgressHard:
		if e.proxyURL == "" {
			return nil
		}
		return egress.ProxyEnv(e.proxyURL)
	case EgressAdvisory:
		// Advisory mode: shared host net, proxy reachable directly on loopback.
		return egress.ProxyEnv("http://" + e.proxy.Addr())
	default:
		return nil
	}
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

func storeEgress(id string, p *egress.Proxy, mode EgressMode, proxyURL string) {
	egressProxies.mu.Lock()
	egressProxies.m[id] = &egressEntry{proxy: p, mode: mode, proxyURL: proxyURL}
	egressProxies.mu.Unlock()
}

// setEgressMode records a mode with no running proxy (off / unrestricted).
func setEgressMode(id string, mode EgressMode) {
	egressProxies.mu.Lock()
	egressProxies.m[id] = &egressEntry{mode: mode}
	egressProxies.mu.Unlock()
}

// StopShellEgress tears down the egress boundary a standalone sandboxed bash shell
// built for itself (its own proxy plus remembered port), called when the ephemeral
// shell process exits. Only these shells own an egress keyed by their shell id;
// agents route teardown through KillHead / removeNamespaceHost instead, so this is
// safe to call for any exiting session and is a no-op unless the id had a
// shell-owned proxy.
func StopShellEgress(id string) {
	stopEgressProxy(id)
	forgetEgressPort(id)
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

// egressPorts remembers the loopback port each head's filtering proxy is bound
// to for the lifetime of its supervisor. In hard mode the
// nft rule on Linux or Seatbelt profile on Darwin bakes in this exact port at
// first launch and never rebuilds it, so every later proxy
// restart for the head (resume, RestartHead, ...) MUST re-bind the same port or
// the agent is firewalled off - a permanent ConnectionRefused. Cleared by
// forgetEgressPort when the supervisor is torn down, so the next platform
// boundary starts from a newly allocated port.
var egressPorts = struct {
	mu sync.Mutex
	m  map[string]int
}{m: map[string]int{}}

func rememberedEgressPort(id string) int {
	egressPorts.mu.Lock()
	defer egressPorts.mu.Unlock()
	return egressPorts.m[id]
}

func setEgressPort(id string, port int) {
	egressPorts.mu.Lock()
	egressPorts.m[id] = port
	egressPorts.mu.Unlock()
}

// forgetEgressPort drops a head's remembered proxy port with its supervisor, so
// the next fresh platform boundary does not try to reclaim a stale one.
func forgetEgressPort(id string) {
	egressPorts.mu.Lock()
	delete(egressPorts.m, id)
	egressPorts.mu.Unlock()
}

// egressApprovalTimeout bounds how long a blocked outbound connection waits for a
// user decision before it is denied (matching the security gate's ask timeout -
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
// status to a policy-approval wait so the toast appears, restoring the status the
// head held beforehand once the last pending host resolves.
//
// It runs on the host (inside the daemon), so unlike the in-sandbox `hydra gate`
// hook it talks to the status/approval files directly rather than over env-var
// paths. A granted host is added to the proxy's live allow-list by the proxy
// itself AND to granted-hosts.json (via the decision handler in
// internal/http/approvals.go), the session grant store shared with the WebFetch
// gate - so one allow covers both layers; "always allow" additionally persists
// it to the project config via the API's remember path.
//
// Before parking a host it re-reads the on-disk config allow-list (liveAllowedHost)
// and auto-allows silently if the host is there now: the proxy snapshots the
// allow-list at launch, so this is what lets a host ADDED to config.toml after a
// head started take effect without a respawn or a prompt.
type egressApprover struct {
	projectRoot string
	id          string
	agentType   sandbox.AgentType
	mu          sync.Mutex
	active      int                  // hosts currently parked; the last to resolve clears the wait
	saved       *api.AgentStatusInfo // head status captured before the first park, restored when the last resolves
}

// liveAllowedHost re-resolves the head's network allow-list from the on-disk config
// and reports whether host is permitted now (allow-listed and not blocked). The
// proxy's allow-list is otherwise fixed at launch, so consulting this before
// prompting is what makes a host added to config.toml post-launch "just work". It
// mirrors the launch-time resolution in startEgress (DefaultAllowedHosts unioned
// with the resolved [sandbox.network] allowed_hosts, minus blocked_hosts).
// Best-effort: a config that won't load falls through to the normal prompt.
func (e *egressApprover) liveAllowedHost(host string) bool {
	cfg, err := config.Load(e.projectRoot)
	if err != nil {
		return false
	}
	_, _, _, _, net, _ := cfg.ResolveSandboxOptions(string(e.agentType))
	if gate.HostAllowed(net.BlockedHosts, host) {
		return false // blocked wins, same as the proxy
	}
	allowed := append(sandbox.DefaultAllowedHosts(e.agentType), net.AllowedHosts...)
	return gate.HostAllowed(allowed, host)
}

// approve is the egress.ApproveFunc: it blocks until the user decides (or the
// timeout/cancel fires), returning whether the connection to host may proceed.
func (e *egressApprover) approve(host string, cancel <-chan struct{}) bool {
	if e.projectRoot == "" {
		return false // no channel to ask over (e.g. tests) → deny, as before
	}
	// A host allow-listed in config.toml after this head launched isn't in the
	// proxy's launch-time snapshot, so it would be parked for a prompt even though
	// the user already granted it. Re-read the on-disk config first and allow it
	// silently if it's there now - no toast, no respawn. The proxy caches the
	// returned host, so this read happens once per host.
	if e.liveAllowedHost(host) {
		log.Printf("hydra egress[%s]: %q is on the current config allow-list; allowing without prompt", e.id, host)
		return true
	}
	dir := paths.GetApprovalsDirFromProjectRoot(e.projectRoot, e.id)
	// A host the user already allowed this session must not prompt again.
	// granted-hosts.json is the shared session grant store written when any
	// WebFetch or egress approval card is allowed; without this check, allowing
	// a WebFetch prompt (which shows the URL before the tool runs) would be
	// followed by a second, redundant prompt here when the fetch's actual
	// connection reaches the proxy.
	if gate.HostAllowed(gate.LoadGrantedHosts(dir), host) {
		log.Printf("hydra egress[%s]: %q was already allowed this session; allowing without prompt", e.id, host)
		return true
	}
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
// so the UI surfaces the approval toast. The first host to park snapshots the
// head's current status so leave() can put it back afterwards, rather than forcing
// "running" over a head that was finished or idle when a background connection was
// parked.
func (e *egressApprover) enter(summary string) {
	e.mu.Lock()
	if e.active == 0 {
		// Capture the pre-approval status, unless it is already one of our own
		// policy-approval waits (e.g. a stale write) - we don't want to "restore"
		// the head right back into a needs-input state.
		if prev := ReadAgentStatus(e.projectRoot, e.id); prev != nil &&
			(prev.NotificationType == nil || *prev.NotificationType != gate.NotificationPolicyApproval) {
			e.saved = prev
		} else {
			e.saved = nil
		}
	}
	e.active++
	e.mu.Unlock()
	e.writeApprovalStatus(summary)
}

// leave drops a resolved host; when it was the last pending one it clears the wait
// by restoring the status the head was in before it was parked.
func (e *egressApprover) leave() {
	e.mu.Lock()
	e.active--
	last := e.active <= 0
	e.mu.Unlock()
	if last {
		e.restore()
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

// restore clears the policy-approval wait by putting back the status the head held
// before it was parked (finished, waiting, running - whatever it was), so resolving
// an egress prompt doesn't leave an idle or finished head looking like it's running.
// It only acts if it still owns the status: if something newer - e.g. the agent's
// own hook - has moved it off our policy-approval wait, that is left in place. When
// no prior status was captured it falls back to "running", the previous behaviour.
func (e *egressApprover) restore() {
	if s := ReadAgentStatus(e.projectRoot, e.id); s != nil &&
		(s.NotificationType == nil || *s.NotificationType != gate.NotificationPolicyApproval) {
		return
	}
	e.mu.Lock()
	prev := e.saved
	e.saved = nil
	e.mu.Unlock()

	next := &api.AgentStatusInfo{Status: api.Running}
	if prev != nil {
		next = prev
	}
	// Advance the timestamp so the JSON poller notices the transition.
	next.Timestamp = time.Now().Format(time.RFC3339Nano)
	_ = WriteAgentStatus(e.projectRoot, e.id, next)
}
