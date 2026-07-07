// Package gate implements Hydra's decision-capable PreToolUse gate: the policy
// that can deny (or park for approval) an agent's tool calls even under
// --dangerously-skip-permissions, where a PreToolUse hook's
// permissionDecision: "deny" still fires ahead of the permission-mode check.
//
// The package is split so the pure decision logic (Decide) and the on-disk
// policy schema are shared between the host (internal/heads seeds policy.json)
// and the in-sandbox hook (internal/cli runs `hydra gate`). It depends only on
// the standard library so it can be exercised in isolation.
package gate

import (
	"encoding/json"
	"os"

	"braces.dev/errtrace"
)

// Environment-variable names the host (internal/heads seeding) sets and the
// in-sandbox hook (`hydra gate`) reads. Kept here so both sides agree.
const (
	// EnvPolicyPath points at the seeded read-only policy.json.
	EnvPolicyPath = "HYDRA_GATE_POLICY_PATH"
	// EnvApprovalDir points at the per-head writable directory used for the
	// "ask" request/decision round-trip.
	EnvApprovalDir = "HYDRA_APPROVAL_DIR"
	// EnvMCPCatalogPath points at the seeded read-only JSON list of host-configured
	// MCP servers (name+source), used by the `hydra mcp` control server to tell the
	// agent which servers it can request access to.
	EnvMCPCatalogPath = "HYDRA_MCP_CATALOG_PATH"
)

// NotificationPolicyApproval is the status.json notification_type the gate sets
// while a head is parked on an approval, so the UI shows the approval card
// rather than a generic "needs you" prompt.
const NotificationPolicyApproval = "policy_approval"

// Policy is the trusted security-gate policy, resolved on the host from the
// project-root config.toml and seeded into the sandbox read-only. The in-sandbox
// hook only ever reads this file - it never parses the branch's TOML - so a
// malicious worktree cannot widen its own policy.
type Policy struct {
	// GateEnabled toggles the runtime decision gate. When false, Decide always
	// allows (pre-launch MCP stripping still applies separately).
	GateEnabled bool `json:"gate_enabled"`
	// MCPAllowed lists the MCP server names the agent may use. A call to any other
	// server is parked for approval (ask); the same servers are also stripped from
	// the seeded config pre-launch so they never spawn. A whole-server grant covers
	// all of that server's tools.
	MCPAllowed []string `json:"mcp_allowed"`
	// MCPToolsAllowed lists individual MCP tools ("<server>__<tool>") the agent may
	// use even when the whole server is NOT on MCPAllowed. It enables per-tool
	// gating: a server with some tools listed here is kept (spawned) so those tools
	// work, while its other tools are parked for approval at runtime.
	MCPToolsAllowed []string `json:"mcp_tools_allowed"`
	// AutoAllowReadMCP, when true, auto-allows an MCP tool the read/write classifier
	// deems read-only, parking only writes/unknown for approval. The classifier is a
	// best-effort heuristic (see ClassifyMCPTool), so this trades safety for fewer
	// prompts - off by default.
	AutoAllowReadMCP bool `json:"mcp_auto_allow_read"`
	// MCPToolRW maps "<server>__<tool>" to a read/write classification ("read" or
	// "write") captured from the server-declared readOnlyHint annotation at seed
	// time. It takes precedence over the name heuristic when present.
	MCPToolRW map[string]string `json:"mcp_tool_rw,omitempty"`
	// KnownTools extends the built-in known-tool allow-list (defaultKnownToolNames)
	// with extra tool names a project marks safe via config (policy.known_tools), so
	// a legitimate tool the gate doesn't ship recognizing can be allowed without a
	// code change instead of parking every call. Matched case-insensitively.
	KnownTools []string `json:"known_tools,omitempty"`
	// WebFetchFilter reports whether WebFetch is host-gated at all. It mirrors the
	// sandbox network policy's FilterHosts: with network filtering off
	// (mode = "unrestricted" or "off") there is nothing to gate - every host is
	// already reachable - so WebFetch is never parked. Only "hard"/"advisory"
	// (FilterHosts on) enforce the allow-list below.
	WebFetchFilter bool `json:"webfetch_filter"`
	// WebFetchAllowHosts lists hosts WebFetch may reach without an approval
	// round-trip when WebFetchFilter is on; a fetch to any other host is parked for
	// approval. It is DERIVED from the network policy - the built-in
	// sandbox.DefaultAllowedHosts unioned with [sandbox.network] allowed_hosts - so
	// the WebFetch tool and the egress boundary share one allow-list rather than two.
	WebFetchAllowHosts []string `json:"webfetch_allow_hosts"`
	// WebFetchBlockedHosts is the network policy's blocked_hosts: a host matching it
	// is denied outright (never parked), since "always allow" could not override a
	// block anyway.
	WebFetchBlockedHosts []string `json:"webfetch_blocked_hosts,omitempty"`
	// Home is the agent's HOME inside the sandbox, used to resolve the credential
	// and policy-file paths Decide protects.
	Home string `json:"home"`
	// WorktreePath is the agent's worktree; in-worktree file writes are allowed.
	WorktreePath string `json:"worktree"`
	// ProjectRoot is the real project root (parent of the worktree), used to resolve
	// the project-relative credential files the gate protects (.hydra/deploy.toml,
	// .hydra/config.local.toml). These are also masked in the sandbox; the gate check
	// is defense-in-depth for the Read tool. "" disables the project-relative check.
	ProjectRoot string `json:"project_root,omitempty"`
}

// LoadPolicy reads a seeded policy.json. A missing file is not an error: it
// yields a zero Policy with the gate disabled, so a launch that never seeded one
// (older head, non-Claude agent) fails open rather than blocking every tool.
func LoadPolicy(path string) (Policy, error) {
	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return Policy{}, nil
	}
	if err != nil {
		return Policy{}, errtrace.Wrap(err)
	}
	var p Policy
	if err := json.Unmarshal(data, &p); err != nil {
		return Policy{}, errtrace.Wrap(err)
	}
	return p, nil
}

// Save writes the policy as indented JSON to path.
func (p Policy) Save(path string) error {
	data, err := json.MarshalIndent(p, "", "  ")
	if err != nil {
		return errtrace.Wrap(err)
	}
	return errtrace.Wrap(os.WriteFile(path, data, 0644))
}
