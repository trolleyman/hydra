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
)

// NotificationPolicyApproval is the status.json notification_type the gate sets
// while a head is parked on an approval, so the UI shows the approval card
// rather than a generic "needs you" prompt.
const NotificationPolicyApproval = "policy_approval"

// Policy is the trusted security-gate policy, resolved on the host from the
// project-root config.toml and seeded into the sandbox read-only. The in-sandbox
// hook only ever reads this file — it never parses the branch's TOML — so a
// malicious worktree cannot widen its own policy.
type Policy struct {
	// GateEnabled toggles the runtime decision gate. When false, Decide always
	// allows (pre-launch MCP stripping still applies separately).
	GateEnabled bool `json:"gate_enabled"`
	// MCPAllowed lists the MCP server names the agent may use. A call to any other
	// server is parked for approval (ask); the same servers are also stripped from
	// the seeded config pre-launch so they never spawn.
	MCPAllowed []string `json:"mcp_allowed"`
	// WebFetchAllowHosts lists hosts WebFetch may reach without an approval
	// round-trip; a fetch to any other host is parked for approval.
	WebFetchAllowHosts []string `json:"webfetch_allow_hosts"`
	// Home is the agent's HOME inside the sandbox, used to resolve the credential
	// and policy-file paths Decide protects.
	Home string `json:"home"`
	// WorktreePath is the agent's worktree; in-worktree file writes are allowed.
	WorktreePath string `json:"worktree"`
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
