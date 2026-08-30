/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { FocusedFilesystemMode } from './FocusedFilesystemMode';
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
     * Switch the shared project checkout to this existing local branch. Valid only for a focused/project-checkout head. This performs a normal non-forced Git checkout, so local changes are preserved when possible and a conflicting switch fails rather than discarding work.
     */
    checkout_branch?: string;
    /**
     * Switch the head between terminal and chat mode (Claude and Codex only; rejected for other agent types). When the value changes, a live process is relaunched and its provider conversation is resumed.
     */
    chat_mode?: boolean;
    filesystem_mode?: FocusedFilesystemMode;
    /**
     * Enable or disable guarded commits for a focused head immediately. Rejected for ordinary worktree heads.
     */
    allow_commits?: boolean;
};

