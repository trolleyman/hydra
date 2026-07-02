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
     * MCP server names the agent may use (whole-server grant). Servers not listed (nor referenced by mcp_tools_allowed) are stripped from the seeded config pre-launch (never spawn). Deny-by-default.
     */
    mcp_allowed?: Array<string> | null;
    /**
     * Individual MCP tools ("<server>__<tool>") allowed even when the whole server is not. The server is kept (spawned) so those tools work; its other tools park for approval at runtime.
     */
    mcp_tools_allowed?: Array<string> | null;
    /**
     * Auto-allow MCP tools the read/write classifier deems read-only, parking only writes/unknown. Best-effort heuristic; off by default.
     */
    mcp_auto_allow_read?: boolean | null;
};

