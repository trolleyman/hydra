/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
export type ApprovalRequest = {
    /**
     * Unique ID of the parked approval request
     */
    reqid: string;
    /**
     * The tool the agent tried to use (e.g. WebFetch or an mcp__ name)
     */
    tool: string;
    /**
     * What is being approved: 'mcp', 'mcp_tool', 'webfetch', 'egress', or 'bash'
     */
    kind: string;
    /**
     * The MCP server name, '<server>__<tool>', host, or command the approval is about
     */
    target: string;
    /**
     * One-line explanation of why the gate parked the call
     */
    reason?: string;
    /**
     * Human-readable "wants to …" summary for the approval card
     */
    summary: string;
    /**
     * Read/write classification of an mcp_tool request ("read", "write", or absent when unknown/not applicable). Best-effort heuristic — a badge hint, not a guarantee.
     */
    rw?: string | null;
    /**
     * The full request URL for a webfetch request (previewed in the card).
     */
    url?: string | null;
    /**
     * Compact one-line preview of an mcp_tool call's arguments.
     */
    args_preview?: string | null;
    /**
     * ISO 8601 timestamp the request was raised
     */
    ts?: string;
};

