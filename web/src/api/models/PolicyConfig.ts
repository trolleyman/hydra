/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
/**
 * Per-agent security-gate policy. The decision-capable gate can deny (or park for approval) tool calls even under skip-permissions.
 */
export type PolicyConfig = {
    /**
     * Enable the decision-capable gate (default true when unset).
     */
    gate_enabled?: boolean | null;
    /**
     * How much of the repo's shared .git the head may write: "readonly" (default, whole .git bound read-only, commits host-mediated) or "off" (writable). Unset inherits the default (readonly). See docs/git-isolation.md.
     */
    git_isolation?: string | null;
    /**
     * MCP server names the agent may use (whole-server grant). Servers not listed (nor referenced by mcp_tools_allowed) are stripped from the seeded config pre-launch (never spawn). Deny-by-default.
     */
    mcp_allowed?: Array<string> | null;
    /**
     * Individual MCP tools ("<server>__<tool>") allowed even when the whole server is not. The server is kept (spawned) so those tools work; its other tools park for approval at runtime.
     */
    mcp_tools_allowed?: Array<string> | null;
    /**
     * MCP server names refused outright - stripped pre-launch and DENIED at runtime (never parked for approval). Block overrides allow; since the allow-lists union across config layers, this is how a narrower layer removes a server a broader layer granted.
     */
    mcp_blocked?: Array<string> | null;
    /**
     * Individual MCP tools ("<server>__<tool>") denied outright even when their server is allowed. Block overrides allow.
     */
    mcp_tools_blocked?: Array<string> | null;
    /**
     * Auto-allow MCP tools the read/write classifier deems read-only, parking only writes/unknown. Best-effort heuristic; off by default.
     */
    mcp_auto_allow_read?: boolean | null;
    /**
     * Make the allow-list the agent's only source of MCP servers: Hydra renders them (plus its own control server) into a per-head config and launches with --strict-mcp-config, so the host's ~/.claude.json and a branch's .mcp.json are ignored outright rather than filtered. Costs the claude.ai account connectors (Gmail/Calendar/Drive), which cannot be re-declared. null = on (the default).
     */
    strict_mcp?: boolean | null;
    /**
     * Allow this head to send attributed messages to other live heads in the same project. Agent discovery remains read-only and available when this is off. null = off (the default).
     */
    agent_messaging?: boolean | null;
    /**
     * Extra tool names the gate treats as safe, extending its built-in known-tool set. Not edited by the Settings UI; carried in responses so a round-tripped save preserves a hand-edited value.
     */
    known_tools?: Array<string> | null;
};

