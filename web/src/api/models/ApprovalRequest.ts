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
     * What is being approved: 'mcp', 'mcp_tool', 'webfetch', 'egress', 'bash', or 'host_command' (run a command on the host, outside the sandbox)
     */
    kind: string;
    /**
     * The MCP server name, '<server>__<tool>', host, or command the approval is about (for host_command, the full command text)
     */
    target: string;
    /**
     * One-line explanation of why the gate parked the call
     */
    reason?: string;
    /**
     * Human-readable "wants to ..." summary for the approval card
     */
    summary: string;
    /**
     * Read/write classification of an mcp_tool request ("read", "write", or absent when unknown/not applicable). Best-effort heuristic - a badge hint, not a guarantee.
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
     * The agent's own explanation of what it is asking for and why it needs to happen outside the sandbox (`hydra host-run --why`). Shown above the command in the approval card, so the user judges a stated intent rather than reverse-engineering one from a shell script.
     */
    description?: string | null;
    /**
     * ISO 8601 timestamp the request was raised
     */
    ts?: string;
};

