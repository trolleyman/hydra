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
    /**
     * True when this head was spawned ON an existing PR/MR Hydra did not create (docs/pr-adoption.md). Such a head has no "Create MR" affordance and its downstream branch (the PR author's source branch) is not editable.
     */
    adopted?: boolean;
    /**
     * Whether we may push to the adopted PR's head branch (always true for a same-repo PR; for a fork only when the author enabled maintainer edits). When false the head is read-only and the Push/Pull affordances are disabled. Only meaningful when adopted is true.
     */
    can_push?: boolean;
};

