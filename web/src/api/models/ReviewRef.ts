/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
/**
 * One existing PR/MR from the forge, for the adoption picker (docs/pr-adoption.md).
 */
export type ReviewRef = {
    /**
     * PR number / MR iid.
     */
    id: string;
    url: string;
    title: string;
    /**
     * Login / username of the PR author.
     */
    author?: string;
    /**
     * Normalized state (draft | open | merged | closed).
     */
    state: string;
    draft?: boolean;
    /**
     * Source branch name on the head repo.
     */
    head_ref: string;
    /**
     * Clone URL of the repo hosting head_ref (empty for a same-repo PR).
     */
    head_repo_url?: string;
    /**
     * The branch the PR merges into (becomes the head's base).
     */
    target_branch: string;
    /**
     * True when the PR was raised from a fork.
     */
    cross_repo: boolean;
    /**
     * Whether we can push to the PR's head branch (false = adoptable read-only only).
     */
    can_push: boolean;
};

