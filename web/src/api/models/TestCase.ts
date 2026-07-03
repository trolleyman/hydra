/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { TestCaseStatus } from './TestCaseStatus';
export type TestCase = {
    /**
     * Leaf test name only when path/scope are set; older reports carry a pre-joined display name here with no path/scope.
     */
    name: string;
    status: TestCaseStatus;
    /**
     * Repo-relative filesystem location — a file (vitest/eslint/pytest) or a package dir (Go). Absent when the runner only exposes a logical scope.
     */
    path?: string | null;
    /**
     * Logical nesting chain between path and name — a class chain (com › example › FooTest), describe chain, or Go subtest parent.
     */
    scope?: Array<string> | null;
    /**
     * Per-level kind for `scope`, parallel to it — "module" (a describe block / class / suite) or "function" (a Go test function that owns subtests). A missing or short array means the level's kind is unknown; consumers treat that as "module".
     */
    scope_kinds?: Array<string> | null;
    /**
     * 1-based line within path, when known.
     */
    line?: number | null;
    col?: number | null;
    end_line?: number | null;
    end_col?: number | null;
    duration_ms?: number;
    /**
     * Failure/assertion text for a failed case (or skip reason for a skipped one)
     */
    message?: string | null;
};

