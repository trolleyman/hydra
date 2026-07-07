/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
/**
 * Patch an agent's mutable fields. Provide any subset; at least one field is required. Omitted fields are left unchanged.
 */
export type UpdateAgentRequest = {
    /**
     * New user-facing display name for the agent. Trimmed; must be non-empty if provided.
     */
    title?: string;
    /**
     * New base branch for the agent. This is a metadata-only change: it updates which branch the agent is considered to be based on (used by update-from-base and the diff view) but does NOT move existing commits. Rebasing the agent's branch onto the new base, if desired, is left to the user. Must be an existing ref.
     */
    base_branch?: string;
    /**
     * Switch the head between terminal and chat mode (Claude only; rejected for other agent types). When the value actually changes and a session is live, the Claude process is stopped and relaunched in the new mode with --continue - the conversation is preserved (terminal and chat mode share one transcript). See CHAT_MODE.md.
     */
    chat_mode?: boolean;
};

