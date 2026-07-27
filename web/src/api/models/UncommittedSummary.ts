/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
export type UncommittedSummary = {
    /**
     * Number of tracked files with staged or unstaged changes
     */
    tracked_count: number;
    /**
     * Number of untracked (new, never-added) files
     */
    untracked_count: number;
    /**
     * Paths of the tracked files with staged or unstaged changes (capped; may be shorter than tracked_count)
     */
    tracked_files?: Array<string>;
    /**
     * Paths of the untracked files (capped; may be shorter than untracked_count)
     */
    untracked_files?: Array<string>;
};

