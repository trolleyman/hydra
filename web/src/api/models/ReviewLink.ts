/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { ReviewState } from './ReviewState';
/**
 * The per-head link to a forge MR/PR (NON_LOCAL_INTEGRATION.md 3.3). Absent on an unlinked head. When present, url/id identify the MR; state (when the lifecycle watcher has run) carries the cached forge state.
 */
export type ReviewLink = {
    /**
     * Forge URL of the MR/PR (deep link for "View MR").
     */
    url: string;
    /**
     * MR/PR identifier on the forge (GitLab IID / GitHub number).
     */
    id: string;
    /**
     * Resolved forge ("github" | "gitlab").
     */
    provider: string;
    /**
     * The MR's target branch.
     */
    target_branch?: string;
    /**
     * Commits the local head branch has that the remote downstream branch does not (drives "Push to MR").
     */
    ahead?: number;
    /**
     * Commits the remote downstream branch has that the local head branch does not (drives "Pull from MR").
     */
    behind?: number;
    state?: ReviewState;
};

