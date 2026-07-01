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
     * MCP server names the agent may use. Servers not listed are stripped from the seeded config pre-launch (never spawn). Deny-by-default.
     */
    mcp_allowed?: Array<string> | null;
    /**
     * Hosts WebFetch may reach without an approval round-trip.
     */
    webfetch_allow_hosts?: Array<string> | null;
};

