/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
export type SpawnAgentRequest = {
    /**
     * The prompt to give to the agent
     */
    prompt?: string;
    /**
     * Explicit identifier for the agent (letters/digits plus ._-, usable as a git branch component). When omitted, the server derives a slug from the prompt and uniquifies it with a -2/-3... suffix, so spawns can never collide. An explicit ID that already exists (active, archived, or in another project) fails with 409 instead of overwriting the existing head.
     */
    id?: string;
    /**
     * With an explicit id, take over an ARCHIVED head with the same ID in this project, overwriting its archived record (the `hydra spawn --force` path). Active heads and heads in other projects still conflict.
     */
    force?: boolean;
    /**
     * Agent type: claude, gemini, copilot, codex, or bash
     */
    agent_type?: string;
    /**
     * Model the agent CLI should use for this session (e.g. "opus", "sonnet", "haiku" for Claude). Passed as the CLI's --model flag at spawn only; on resume it is omitted so the agent restores the model its transcript was saved with (and honours any in-session /model change). Empty/omitted inherits the CLI's own default.
     */
    model?: string;
    /**
     * Base branch to create the worktree from (defaults to current branch)
     */
    base_branch?: string;
    /**
     * Drive the head via its structured protocol and render a chat view instead of a terminal (Claude and Codex only; rejected for other agent types). The prompt is delivered as the first chat turn.
     */
    chat_mode?: boolean;
    /**
     * If true, the agent is a throwaway test agent whose worktree and branch are torn down when it stops.
     */
    ephemeral?: boolean;
    /**
     * Initial PTY width (columns), seeded from the spawning browser's last terminal geometry so the agent renders at the right width immediately instead of the 80-column default. When omitted, the server falls back to the project's most recently reported width (else 80).
     */
    cols?: number;
    /**
     * Initial PTY height (rows). The browser sends its last terminal height, or the user's configured default height when it has none yet. When omitted the PTY uses its built-in 24-row default.
     */
    rows?: number;
};

