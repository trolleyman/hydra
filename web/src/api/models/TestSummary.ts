/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { TestStatus } from './TestStatus';
/**
 * Compact per-head test verdict for the head's current commit, shown as the sidebar/header chip without opening the tests panel (PLAN #68). Computed from the cached report without triggering a run.
 */
export type TestSummary = {
    status: TestStatus;
    total?: number;
    passed?: number;
    failed?: number;
    skipped?: number;
    duration_ms?: number | null;
    /**
     * Latest progress line while status is "running" (e.g. "84/142").
     */
    progress?: string | null;
    /**
     * The resolved commit SHA the verdict was computed for.
     */
    ref?: string | null;
};

