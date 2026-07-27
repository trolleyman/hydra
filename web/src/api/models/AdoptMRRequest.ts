/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
/**
 * Adopt an existing PR/MR as this head instead of branching from base (docs/pr-adoption.md). The worktree is created from the PR's head commit, the head's base becomes the PR's target branch, and the head is pre-linked to the MR.
 */
export type AdoptMRRequest = {
    /**
     * The PR number / MR iid to adopt.
     */
    id: string;
    /**
     * Git remote to resolve the forge against (defaults to the configured review remote, usually "origin").
     */
    remote?: string;
};

