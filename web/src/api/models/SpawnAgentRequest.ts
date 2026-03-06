/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
export type SpawnAgentRequest = {
    /**
     * The prompt to give to the agent
     */
    prompt: string;
    /**
     * Unique identifier for the agent (slug format, max 40 chars)
     */
    id: string;
    /**
     * Agent type: claude or gemini
     */
    agent_type?: string;
    /**
     * Base branch to create the worktree from (defaults to current branch)
     */
    base_branch?: string;
    /**
     * If true, the agent is temporary and its container will be removed on stop.
     */
    ephemeral?: boolean;
};

