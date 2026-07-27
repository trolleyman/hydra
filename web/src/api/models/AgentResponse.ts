/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { AgentStatusInfo } from './AgentStatusInfo';
import type { ReviewLink } from './ReviewLink';
import type { TestSummary } from './TestSummary';
export type AgentResponse = {
    id: string;
    /**
     * Mutable, user-facing display name. May be empty before it is seeded; clients should fall back to id.
     */
    title?: string;
    /**
     * The chat plan/to-do list JSON the daemon tracks from the head's live Task*TodoWrite events (empty if none).
     */
    plan?: string;
    /**
     * The chat head's current model id, captured by the daemon from the CLI's system:init line (empty if not yet observed).
     */
    model?: string;
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
     * True when the head runs in structured chat mode (Claude or Codex).
     */
    chat_mode?: boolean;
    /**
     * Unix timestamp (seconds) when the session was started; 0 if not started
     */
    created_at?: number;
    /**
     * Network egress posture for a live head: "off" (no network), "unrestricted" (network on, host filtering off → every host reachable), "filtered-hard" (allow-list enforced in a pasta netns + nft lock - an inescapable boundary), "filtered-advisory" (allow-list enforced by the proxy via HTTP(S)_PROXY only; a determined process can bypass it), or absent/empty (the head isn't live).
     */
    network_enforcement?: string;
    /**
     * Effective git-isolation mode for this head: "off" (the shared .git is writable in the sandbox) or "readonly" (the whole .git is bound read-only, so commits are host-mediated). See docs/git-isolation.md.
     */
    git_isolation?: string;
    agent_status?: AgentStatusInfo;
    /**
     * True if the agent has changes the user has not yet looked at (set on a running→waiting/finished transition, cleared when the agent is opened).
     */
    has_unread_changes?: boolean;
    /**
     * True if the agent is a finished (killed/merged) head retained in the history list. Archived agents are read-only - they have no live session or worktree.
     */
    archived?: boolean;
    /**
     * How an archived agent ended ("killed" | "merged"); null/absent for active agents.
     */
    end_state?: string | null;
    tests?: TestSummary;
    /**
     * True when auto-merge is armed (the head will merge once its tests settle passing). See PLAN
     */
    merge_when_green?: boolean;
    /**
     * True when publish-when-green is armed (the head auto-opens a draft MR / auto-pushes once its tests settle passing and it finishes). See NON_LOCAL_INTEGRATION.md 3.5.
     */
    publish_when_green?: boolean;
    /**
     * The branch name this head's work is (or will be) pushed AS on the remote. The local branch always stays hydra/<id>. Empty until set.
     */
    downstream_branch?: string;
    review?: ReviewLink;
};

