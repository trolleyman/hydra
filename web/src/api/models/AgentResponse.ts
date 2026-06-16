/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { AgentStatusInfo } from './AgentStatusInfo';
export type AgentResponse = {
    id: string;
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
    agent_status?: AgentStatusInfo;
    /**
     * True if the agent has changes the user has not yet looked at (set on a running→waiting/finished transition, cleared when the agent is opened).
     */
    has_unread_changes?: boolean;
};

