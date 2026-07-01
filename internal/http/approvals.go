package http

import (
	"context"
	"log"
	"time"

	"braces.dev/errtrace"
	"github.com/trolleyman/hydra/internal/api"
	"github.com/trolleyman/hydra/internal/config"
	"github.com/trolleyman/hydra/internal/gate"
	"github.com/trolleyman/hydra/internal/heads"
	"github.com/trolleyman/hydra/internal/paths"
)

// ListAgentApprovals returns the security-gate approval requests a head has
// parked (tool calls the gate decided need the user's allow/deny). The UI fetches
// these when a head is in a policy_approval wait and renders an approval card.
func (s *Server) ListAgentApprovals(ctx context.Context, request api.ListAgentApprovalsRequestObject) (api.ListAgentApprovalsResponseObject, error) {
	projectRoot, err := s.resolveProjectRoot(request.ProjectId)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	head, err := heads.GetHeadByID(ctx, s.Sessions, s.DB, projectRoot, request.Id)
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

	reqs, err := gate.ListRequests(paths.GetApprovalsDirFromProjectRoot(projectRoot, request.Id))
	if err != nil {
		return api.ListAgentApprovals500JSONResponse{
			Code:    500,
			Error:   api.ErrorResponseErrorInternalError,
			Details: err.Error(),
		}, nil
	}

	out := make([]api.ApprovalRequest, 0, len(reqs))
	for _, r := range reqs {
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
		out = append(out, req)
	}
	return api.ListAgentApprovals200JSONResponse{Approvals: out}, nil
}

// DecideAgentApproval records the user's verdict for a parked tool call. It
// writes the decision file the in-sandbox `hydra gate` hook is polling (which
// unblocks the agent), and — when the user chose "always allow" — persists the
// server/host to the trusted project config so future launches don't ask again.
func (s *Server) DecideAgentApproval(ctx context.Context, request api.DecideAgentApprovalRequestObject) (api.DecideAgentApprovalResponseObject, error) {
	projectRoot, err := s.resolveProjectRoot(request.ProjectId)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	head, err := heads.GetHeadByID(ctx, s.Sessions, s.DB, projectRoot, request.Id)
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

	dir := paths.GetApprovalsDirFromProjectRoot(projectRoot, request.Id)
	allow := request.Body.Decision == api.Allow
	decision := gate.Deny
	if allow {
		decision = gate.Allow
	}
	remember := request.Body.Remember != nil && *request.Body.Remember

	// Persist a remembered "always allow" to the trusted config BEFORE writing the
	// decision file, so the allow-list update can't be lost if the next launch
	// races the agent unblocking. Best-effort: a persistence failure still lets
	// the one-shot decision through.
	var grantedMCPKind string // "mcp"/"mcp_tool" when a remembered MCP grant was persisted
	if allow && remember {
		if req, ok, _ := gate.ReadRequest(dir, request.Reqid); ok {
			if err := rememberApproval(projectRoot, string(head.AgentType), req.Kind, req.Target); err != nil {
				return api.DecideAgentApproval500JSONResponse{
					Code:    500,
					Error:   api.ErrorResponseErrorInternalError,
					Details: "remember approval: " + err.Error(),
				}, nil
			}
			if req.Kind == "mcp" || req.Kind == "mcp_tool" {
				grantedMCPKind = req.Kind
			}
		}
	}

	if err := gate.WriteDecision(dir, request.Reqid, gate.DecisionFile{Decision: decision, Remember: remember}); err != nil {
		return api.DecideAgentApproval500JSONResponse{
			Code:    500,
			Error:   api.ErrorResponseErrorInternalError,
			Details: err.Error(),
		}, nil
	}

	// Nudge the UI to refresh: once the gate reads the decision and proceeds the
	// head leaves its policy_approval wait, and the parked request drops off the list.
	s.Events.AgentsChanged(projectRoot)

	// A remembered MCP grant only takes effect at launch (MCP servers load then),
	// so relaunch the head with --continue to make it available immediately. Async
	// + slightly delayed so the gate reads the Allow decision and the tool call
	// returns cleanly before the session is recycled; the conversation is restored.
	if grantedMCPKind != "" {
		headCopy := *head
		go func() {
			time.Sleep(1500 * time.Millisecond)
			rows, cols := heads.LoadResumeSize(s.DB, projectRoot, headCopy.ID)
			if err := heads.RestartHead(s.Sessions, s.DB, projectRoot, headCopy, rows, cols); err != nil {
				log.Printf("hydra: auto-restart after MCP approval for %s: %v", headCopy.ID, err)
			} else {
				s.Events.AgentsChanged(projectRoot)
			}
		}()
	}
	return api.DecideAgentApproval204Response{}, nil
}

// rememberApproval appends an approved MCP server / WebFetch host to the trusted
// PROJECT config's per-agent allow-list (never the merged user/default config),
// so it takes effect on the head's next launch. A "bash" approval (e.g. git push)
// is one-shot and not persisted.
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
	ac := cfg.Agents[agentType]
	if ac.Policy == nil {
		ac.Policy = &config.PolicyConfig{}
	}
	switch kind {
	case "mcp":
		ac.Policy.MCPAllowed = appendUnique(ac.Policy.MCPAllowed, target)
	case "mcp_tool":
		ac.Policy.MCPToolsAllowed = appendUnique(ac.Policy.MCPToolsAllowed, target)
	case "webfetch":
		ac.Policy.WebFetchAllowHosts = appendUnique(ac.Policy.WebFetchAllowHosts, target)
	default:
		return nil // not a rememberable kind
	}
	if cfg.Agents == nil {
		cfg.Agents = map[string]config.AgentConfig{}
	}
	cfg.Agents[agentType] = ac
	return errtrace.Wrap(config.Save(projectRoot, *cfg))
}

func appendUnique(list []string, v string) []string {
	for _, x := range list {
		if x == v {
			return list
		}
	}
	return append(list, v)
}
