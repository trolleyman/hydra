/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
/**
 * A candidate MCP server discovered in the host/project config.
 */
export type McpServer = {
    /**
     * The server key as it appears under mcpServers.
     */
    name: string;
    /**
     * Where it was found - "user" (~/.claude.json) or "project" (.mcp.json).
     */
    source: string;
};

