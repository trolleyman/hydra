/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { AutoRunMode } from './AutoRunMode';
/**
 * Execution and cache policy shared by tests and diff artifacts.
 */
export type CachedRunPolicy = {
    /**
     * Max seconds the command may run (0 = built-in default).
     */
    timeout_sec?: number;
    /**
     * Also delete git-ignored files before each run (git clean -fdx instead of -fd); slower, but prevents stale ignored output leaking between runs.
     */
    clean_ignored?: boolean;
    auto_run?: AutoRunMode;
};

