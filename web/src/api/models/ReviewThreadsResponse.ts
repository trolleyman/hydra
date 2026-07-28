/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { ReviewThread } from './ReviewThread';
/**
 * The review conversations on a head's MR, forge threads and Hydra's local-only notes merged (docs/review-threads.md).
 */
export type ReviewThreadsResponse = {
    threads: Array<ReviewThread>;
    /**
     * False when the head has no MR - the diff viewer then shows local comments only.
     */
    linked: boolean;
    /**
     * "github" | "gitlab" - drives the origin badge on forge threads.
     */
    provider?: string;
    /**
     * The MR/PR the threads belong to.
     */
    mr_url?: string;
    /**
     * RFC3339 time the threads were read from the forge.
     */
    fetched_at?: string;
    /**
     * True when the live forge read failed and these are the last cached threads.
     */
    stale?: boolean;
    /**
     * Why the live read failed (present with stale=true).
     */
    error?: string;
};

