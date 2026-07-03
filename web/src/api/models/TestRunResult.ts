/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { ArtifactLogLine } from './ArtifactLogLine';
import type { TestCase } from './TestCase';
import type { TestStatus } from './TestStatus';
/**
 * One test runner's parsed result for a single ref (single-sided; no comparison)
 */
export type TestRunResult = {
    /**
     * The configured test runner name
     */
    name: string;
    status: TestStatus;
    total?: number;
    /**
     * True when `total` is an estimated denominator carried over from a prior run (the streaming runner declared no ::hydra:test:total::). Only set while running; the UI shows it as approximate.
     */
    total_estimated?: boolean | null;
    passed?: number;
    failed?: number;
    skipped?: number;
    /**
     * Non-failing diagnostics (e.g. eslint warnings). Informational only — never part of the merge gate.
     */
    warnings?: number;
    duration_ms?: number | null;
    /**
     * Set when status is "errored" — the command couldn't produce a verdict.
     */
    error?: string | null;
    /**
     * Resolved commit SHA the run was computed for.
     */
    ref?: string | null;
    /**
     * Report format parsed (junit | hydra | exit).
     */
    format?: string | null;
    /**
     * Unix time (seconds) the in-flight run started. Only set while running.
     */
    started_at?: number | null;
    /**
     * Latest progress line of the in-flight run (from ::hydra:progress:: markers, else latest stdout). Only set while running.
     */
    progress?: string | null;
    /**
     * Captured stdout+stderr lines of the in-flight run. Only while running; once settled fetch log_url.
     */
    log?: Array<ArtifactLogLine> | null;
    /**
     * URL to fetch the persisted build log once the run has settled.
     */
    log_url?: string | null;
    /**
     * Parsed test cases (failing first when the UI orders them).
     */
    cases?: Array<TestCase>;
};

