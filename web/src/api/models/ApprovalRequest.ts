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
     * What is being approved: 'mcp', 'webfetch', or 'bash'
     */
    kind: string;
    /**
     * The MCP server name, host, or command the approval is about
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
     * ISO 8601 timestamp the request was raised
     */
    ts?: string;
};

