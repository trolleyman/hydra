/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { AgentStatusInfo } from './AgentStatusInfo';
export type AgentResponse = {
    id: string;
    /**
     * Mutable, user-facing display name. May be empty before it is seeded; clients should fall back to id.
     */
    title?: string;
    branch_name?: string | null;
    worktree_path?: string | null;
    project_path: string;
    /**
     * PID of the running sandbox session, or 0 if not running
     */
    session_pid: number;
    /**
     * Sandbox session status (pending|starting|running|stopped)
     */
    session_status: string;
    agent_type: string;
    pre_prompt: string;
    prompt: string;
    base_branch: string;
    /**
     * If true, the agent is a throwaway test agent whose worktree and branch are torn down when it stops.
     */
    ephemeral?: boolean;
    /**
     * Unix timestamp (seconds) when the session was started; 0 if not started
     */
    created_at?: number;
    /**
     * Network egress posture for a live head: "off" (no network), "filtered-hard" (allow-list enforced in a pasta netns + nft lock — an inescapable boundary), "filtered-advisory" (allow-list enforced by the proxy via HTTP(S)_PROXY only; a determined process can bypass it), or absent/empty (no allow-list → unrestricted, or the head isn't live).
     */
    network_enforcement?: string;
    agent_status?: AgentStatusInfo;
    /**
     * True if the agent has changes the user has not yet looked at (set on a running→waiting/finished transition, cleared when the agent is opened).
     */
    has_unread_changes?: boolean;
    /**
     * True if the agent is a finished (killed/merged) head retained in the history list. Archived agents are read-only — they have no live session or worktree.
     */
    archived?: boolean;
    /**
     * How an archived agent ended ("killed" | "merged"); null/absent for active agents.
     */
    end_state?: string | null;
};

