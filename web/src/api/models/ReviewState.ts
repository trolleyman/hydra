/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
/**
 * Cached forge MR state from the lifecycle watcher (Phase 3). Absent until the watcher has polled.
 */
export type ReviewState = {
    /**
     * Normalized MR state (draft | open | merged | closed).
     */
    state: string;
    /**
     * Normalized CI status (success | failed | running | pending | none).
     */
    ci_status?: string;
    approvals?: number;
    approvals_required?: number;
    unresolved_discussions?: number;
    mergeable?: boolean;
};

