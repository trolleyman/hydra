package http

import (
	"context"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"time"

	"braces.dev/errtrace"
	"github.com/trolleyman/hydra/internal/api"
	"github.com/trolleyman/hydra/internal/config"
	"github.com/trolleyman/hydra/internal/gate"
	"github.com/trolleyman/hydra/internal/heads"
	"github.com/trolleyman/hydra/internal/paths"
	"github.com/trolleyman/hydra/internal/sandbox"
)

// ListAgentApprovals returns the security-gate approval requests a head has
// parked (tool calls the gate decided need the user's allow/deny). The UI fetches
// these when a head is in a policy_approval wait and renders an approval card.
func (s *Server) ListAgentApprovals(ctx context.Context, request api.ListAgentApprovalsRequestObject) (api.ListAgentApprovalsResponseObject, error) {
	projectRoot, err := s.resolveProjectRoot(request.ProjectId)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	head, err := heads.GetHeadByID(ctx, s.Sessions, s.DB, projectRoot, request.AgentId)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	if head == nil {
		return api.ListAgentApprovals404JSONResponse{
			Code:    404,
			Error:   api.ErrorResponseErrorNotFound,
			Details: "agent not found",
		}, nil
	}

	reqs, err := gate.ListRequests(paths.GetApprovalsDirFromProjectRoot(projectRoot, request.AgentId))
	if err != nil {
		return api.ListAgentApprovals500JSONResponse{
			Code:    500,
			Error:   api.ErrorResponseErrorInternalError,
			Details: err.Error(),
		}, nil
	}

	out := make([]api.ApprovalRequest, 0, len(reqs))
	for _, r := range reqs {
		// Resolve filesystem requests on the host before showing them. The agent
		// cannot inspect an unmounted path from inside its sandbox, and the echoed
		// canonical target is what the decision handler trusts and mounts.
		if r.Kind == "filesystem_read" {
			canonical, resolveErr := canonicalReadablePath(r.Target)
			if resolveErr != nil {
				r.Reason = resolveErr.Error()
			} else {
				r.Target = canonical
			}
		}
		reason, ts := r.Reason, r.TS
		req := api.ApprovalRequest{
			Reqid:   r.ReqID,
			Tool:    r.Tool,
			Kind:    r.Kind,
			Target:  r.Target,
			Summary: r.Summary,
			Reason:  &reason,
			Ts:      &ts,
		}
		if r.RW != "" {
			rw := r.RW
			req.Rw = &rw
		}
		if r.URL != "" {
			u := r.URL
			req.Url = &u
		}
		if r.ArgsPreview != "" {
			a := r.ArgsPreview
			req.ArgsPreview = &a
		}
		if r.Description != "" {
			d := r.Description
			req.Description = &d
		}
		out = append(out, req)
	}
	return api.ListAgentApprovals200JSONResponse{Approvals: out}, nil
}

// DecideAgentApproval records the user's verdict for a parked tool call. It
// writes the decision file the in-sandbox `hydra gate` hook is polling (which
// unblocks the agent), and - when the user chose "always allow" - persists the
// server/host to the trusted project config so future launches don't ask again.
func (s *Server) DecideAgentApproval(ctx context.Context, request api.DecideAgentApprovalRequestObject) (api.DecideAgentApprovalResponseObject, error) {
	projectRoot, err := s.resolveProjectRoot(request.ProjectId)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	head, err := heads.GetHeadByID(ctx, s.Sessions, s.DB, projectRoot, request.AgentId)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	if head == nil {
		return api.DecideAgentApproval404JSONResponse{
			Code:    404,
			Error:   api.ErrorResponseErrorNotFound,
			Details: "agent not found",
		}, nil
	}
	if request.Body == nil {
		return api.DecideAgentApproval500JSONResponse{
			Code:    500,
			Error:   api.ErrorResponseErrorInternalError,
			Details: "missing decision body",
		}, nil
	}

	dir := paths.GetApprovalsDirFromProjectRoot(projectRoot, request.AgentId)
	allow := request.Body.Decision == api.Allow
	decision := gate.Deny
	if allow {
		decision = gate.Allow
	}
	remember := request.Body.Remember != nil && *request.Body.Remember

	// host_command is the sandbox escape hatch (`hydra host-run`): on allow, the
	// DAEMON runs the command host-side and the CLI relays the result. It is handled
	// on its own path - it is never "remembered", and on allow we kick off host-side
	// execution before writing the decision the CLI is polling for.
	if req, ok, _ := gate.ReadRequest(dir, request.Reqid); ok && req.Kind == "host_command" {
		if allow {
			// Run EXACTLY the command text the UI echoed back (what the user saw and
			// approved), not req.Target from the head-writable request file - that echo
			// is the TOCTOU defense. An allow with no echoed command is treated as a
			// deny (nothing to safely run).
			command := ""
			if request.Body.Command != nil {
				command = *request.Body.Command
			}
			if command == "" {
				_ = gate.WriteDecision(dir, request.Reqid, gate.DecisionFile{Decision: gate.Deny})
				s.Events.AgentsChanged(projectRoot)
				return api.DecideAgentApproval204Response{}, nil
			}
			go runApprovedHostCommand(dir, request.Reqid, head.WorkingDir(), command)
		}
		if err := gate.WriteDecision(dir, request.Reqid, gate.DecisionFile{Decision: decision}); err != nil {
			return api.DecideAgentApproval500JSONResponse{
				Code:    500,
				Error:   api.ErrorResponseErrorInternalError,
				Details: err.Error(),
			}, nil
		}
		s.Events.AgentsChanged(projectRoot)
		return api.DecideAgentApproval204Response{}, nil
	}

	// Persist a remembered "always allow" to the trusted config BEFORE writing the
	// decision file, so the allow-list update can't be lost if the next launch
	// races the agent unblocking. A failure leaves the request pending.
	var restartSandbox bool   // a filesystem grant changes the outer sandbox mounts
	var grantedMCPKind string // "mcp"/"mcp_tool" when a remembered MCP grant was persisted
	var grantedHost string    // webfetch/egress host this session grant now covers
	var grantedReadable string
	var approvedReq gate.Request
	var haveApprovedReq bool
	if allow {
		approvedReq, haveApprovedReq, _ = gate.ReadRequest(dir, request.Reqid)
		if haveApprovedReq && (approvedReq.Kind == "webfetch" || approvedReq.Kind == "egress") {
			grantedHost = approvedReq.Target
		}
		if haveApprovedReq && approvedReq.Kind == "filesystem_read" {
			if request.Body.Path == nil {
				return approvalDecisionError("filesystem approval is missing the displayed path"), nil
			}
			canonical, pathErr := canonicalReadablePath(*request.Body.Path)
			if pathErr != nil {
				return approvalDecisionError(pathErr.Error()), nil
			}
			// Trust the path echoed by the UI, not the agent-writable request file.
			approvedReq.Target = canonical
			cfg, _ := config.Load(projectRoot)
			_, _, masked, _, _, _ := cfg.ResolveSandboxOptions(string(head.AgentType))
			for _, hidden := range sandbox.ResolveMaskedPaths(projectRoot, head.WorkingDir(), masked) {
				if pathWithin(canonical, hidden) {
					return approvalDecisionError(fmt.Sprintf("host path %q is hidden by masked_paths and cannot be granted", canonical)), nil
				}
			}
			grantedReadable = canonical
			restartSandbox = true
		}
	}
	if allow && remember {
		if haveApprovedReq {
			if err := rememberApproval(projectRoot, string(head.AgentType), approvedReq.Kind, approvedReq.Target); err != nil {
				return api.DecideAgentApproval500JSONResponse{
					Code:    500,
					Error:   api.ErrorResponseErrorInternalError,
					Details: "remember approval: " + err.Error(),
				}, nil
			}
			switch approvedReq.Kind {
			case "mcp", "mcp_tool":
				grantedMCPKind = approvedReq.Kind
			}
		}
	}
	if grantedReadable != "" {
		if err := gate.AddGrantedReadablePath(dir, grantedReadable); err != nil {
			return approvalDecisionError("grant read access: " + err.Error()), nil
		}
	}

	if err := gate.WriteDecision(dir, request.Reqid, gate.DecisionFile{Decision: decision, Remember: remember}); err != nil {
		return api.DecideAgentApproval500JSONResponse{
			Code:    500,
			Error:   api.ErrorResponseErrorInternalError,
			Details: err.Error(),
		}, nil
	}

	// Any host approval covers the rest of this running session ("always allow"
	// additionally persisted it above). Resolve every OTHER parked WebFetch/egress
	// request for the same host, so a parallel WebFetch + shell request cannot show
	// two identical prompts or leave one half of the tool batch blocked. The seeded
	// gate policy is read-only, so granted-hosts.json is its live session overlay -
	// read by the in-sandbox gate hook AND by the egress approver before parking a
	// connection, so allowing a WebFetch prompt also pre-clears the fetch's actual
	// connection at the proxy (and vice versa).
	if grantedHost != "" {
		grantHostForSession(dir, request.Reqid, grantedHost)
	}

	// Nudge the UI to refresh: once the gate reads the decision and proceeds the
	// head leaves its policy_approval wait, and the parked request drops off the list.
	s.Events.AgentsChanged(projectRoot)

	// MCP servers and filesystem mounts only change at launch, so relaunch the head
	// with --continue to apply either capability immediately. A filesystem grant
	// also tears down the namespace host because mounts live in that outer sandbox.
	// Delay slightly so the tool call can observe Allow before it is recycled.
	if grantedMCPKind != "" || restartSandbox {
		headCopy := *head
		go func() {
			time.Sleep(1500 * time.Millisecond)
			rows, cols := heads.LoadResumeSize(s.DB, projectRoot, headCopy.ID)
			var restartErr error
			if restartSandbox {
				restartErr = heads.RestartHeadSandbox(s.Sessions, s.DB, projectRoot, headCopy, rows, cols)
			} else {
				restartErr = heads.RestartHead(s.Sessions, s.DB, projectRoot, headCopy, rows, cols)
			}
			if restartErr != nil {
				log.Printf("hydra: auto-restart after capability approval for %s: %v", headCopy.ID, restartErr)
			} else {
				s.Events.AgentsChanged(projectRoot)
			}
		}()
	}
	return api.DecideAgentApproval204Response{}, nil
}

func grantHostForSession(dir, exceptReqID, host string) {
	_ = gate.AddGrantedHost(dir, host)
	resolveSiblingHostApprovals(dir, exceptReqID, host)
}

// resolveSiblingHostApprovals allows every still-parked WebFetch/egress request in
// dir whose host matches the just-granted host (except the one already decided).
// It runs after a host is allowed for the session: sibling requests no longer
// need a separate click - writing their decisions unblocks the gate/proxy
// and the UI drops their toasts on the next poll. Best-effort; a write failure just
// leaves that sibling to be resolved normally.
func resolveSiblingHostApprovals(dir, exceptReqID, host string) {
	reqs, err := gate.ListRequests(dir)
	if err != nil {
		return
	}
	for _, r := range reqs {
		if r.ReqID == exceptReqID || (r.Kind != "webfetch" && r.Kind != "egress") {
			continue
		}
		if gate.HostAllowed([]string{host}, r.Target) {
			_ = gate.WriteDecision(dir, r.ReqID, gate.DecisionFile{Decision: gate.Allow})
		}
	}
}

// rememberApproval appends an approved MCP server / MCP tool / host / readable
// path to the trusted PROJECT config (never the merged user/default config), so
// it takes effect on the head's next launch. MCP grants are agent-specific and
// go to [<agent>.policy], while filesystem paths go to [<agent>.sandbox]. A WebFetch or
// egress host both go to the DEFAULTS-level
// [sandbox.network] allowed_hosts - one shared list applied to every agent, since
// the egress allow-list is a project-wide posture, not a per-agent capability. An
// egress host also goes live for the current session in the running proxy's
// allow-list (handled where the proxy reads the Allow decision), and any host goes
// live for both network layers via gate.AddGrantedHost (see the caller). Any other
// kind is one-shot and not persisted (default case).
func rememberApproval(projectRoot, agentType, kind, target string) error {
	if target == "" {
		return nil
	}
	cfg, err := config.LoadFile(config.GetProjectConfigPath(projectRoot))
	if err != nil {
		return errtrace.Wrap(err)
	}
	if cfg == nil {
		cfg = &config.Config{}
	}
	switch kind {
	case "mcp", "mcp_tool", "filesystem_read":
		// MCP and filesystem grants stay per-agent. MCP entries land in policy;
		// readable paths land in that agent's sandbox settings.
		ac := cfg.Agents[agentType]
		if kind == "mcp" {
			ensurePolicy(&ac).MCPAllowed = appendUnique(ensurePolicy(&ac).MCPAllowed, target)
		} else if kind == "mcp_tool" {
			ensurePolicy(&ac).MCPToolsAllowed = appendUnique(ensurePolicy(&ac).MCPToolsAllowed, target)
		} else {
			ensureSandbox(&ac).ReadablePaths = appendUnique(ensureSandbox(&ac).ReadablePaths, target)
		}
		if cfg.Agents == nil {
			cfg.Agents = map[string]config.AgentConfig{}
		}
		cfg.Agents[agentType] = ac
	case "webfetch", "egress":
		// WebFetch host-gating and egress filtering share one allow-list, and it is
		// a project-wide egress posture rather than an agent-specific grant, so a
		// remembered host goes to the DEFAULTS-level [sandbox.network] allowed_hosts
		// (shared by every agent), NOT [<agent>.sandbox.network].
		net := ensureNetwork(&cfg.Defaults)
		net.AllowedHosts = appendUnique(net.AllowedHosts, target)
	default:
		return nil // not a rememberable kind
	}
	return errtrace.Wrap(config.Save(projectRoot, *cfg))
}

func ensureSandbox(ac *config.AgentConfig) *config.SandboxConfig {
	if ac.Sandbox == nil {
		ac.Sandbox = &config.SandboxConfig{}
	}
	return ac.Sandbox
}

func approvalDecisionError(details string) api.DecideAgentApproval500JSONResponse {
	return api.DecideAgentApproval500JSONResponse{Code: 500, Error: api.ErrorResponseErrorInternalError, Details: details}
}

// canonicalReadablePath turns the path the user sees into the exact existing
// host file/directory the sandbox backend will receive. Symlinks are resolved so
// an innocuous alias cannot silently mount a different target after approval.
func canonicalReadablePath(path string) (string, error) {
	path = strings.TrimSpace(path)
	if path == "~" || strings.HasPrefix(path, "~/") || (os.PathSeparator == '\\' && strings.HasPrefix(path, `~\`)) {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", errtrace.Wrap(fmt.Errorf("resolve home directory: %w", err))
		}
		path = filepath.Join(home, strings.TrimLeft(strings.TrimPrefix(path, "~"), `/\`))
	}
	if !filepath.IsAbs(path) {
		return "", errtrace.Wrap(fmt.Errorf("read access requires an absolute host path or a path beginning with ~/"))
	}
	canonical, err := filepath.EvalSymlinks(filepath.Clean(path))
	if err != nil {
		return "", errtrace.Wrap(fmt.Errorf("cannot resolve host path %q: %w", path, err))
	}
	info, err := os.Stat(canonical)
	if err != nil {
		return "", errtrace.Wrap(fmt.Errorf("cannot inspect host path %q: %w", canonical, err))
	}
	if !info.IsDir() && !info.Mode().IsRegular() {
		return "", errtrace.Wrap(fmt.Errorf("host path %q is not a regular file or directory", canonical))
	}
	return canonical, nil
}

func pathWithin(path, parent string) bool {
	rel, err := filepath.Rel(filepath.Clean(parent), filepath.Clean(path))
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

// ensurePolicy lazily allocates the agent config's policy section.
func ensurePolicy(ac *config.AgentConfig) *config.PolicyConfig {
	if ac.Policy == nil {
		ac.Policy = &config.PolicyConfig{}
	}
	return ac.Policy
}

// ensureNetwork lazily allocates a config section's sandbox.network (where the
// egress allow-list lives). Works for both a per-agent config and cfg.Defaults.
func ensureNetwork(ac *config.AgentConfig) *config.NetworkConfig {
	if ac.Sandbox == nil {
		ac.Sandbox = &config.SandboxConfig{}
	}
	if ac.Sandbox.Network == nil {
		ac.Sandbox.Network = &config.NetworkConfig{}
	}
	return ac.Sandbox.Network
}

func appendUnique(list []string, v string) []string {
	for _, x := range list {
		if x == v {
			return list
		}
	}
	return append(list, v)
}
