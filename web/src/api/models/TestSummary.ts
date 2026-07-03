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
    /**
     * Non-failing diagnostics (e.g. eslint warnings). Informational only - never part of the merge gate. Shown in the long chip / panel, not the short sidebar chip.
     */
    warnings?: number;
    duration_ms?: number | null;
    /**
     * Latest progress line while status is "running" (e.g. "84/142").
     */
    progress?: string | null;
    /**
     * The resolved commit SHA the verdict was computed for.
     */
    ref?: string | null;
    /**
     * True when the head's branch tip is still the base branch commit, so this verdict is inherited from the base rather than the agent's own work. The ambient sidebar chip hides it in this case; the agent detail view still shows it.
     */
    at_base?: boolean | null;
};

