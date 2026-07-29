/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { TestCase } from './TestCase';
/**
 * Authoritative running totals - not deltas - plus the newly-appended cases the client merges into its case list.
 */
export type TestsCounts = {
    passed: number;
    failed: number;
    skipped: number;
    warnings: number;
    /**
     * The denominator; 0 means unknown.
     */
    total: number;
    /**
     * The total is an estimate carried from a prior run, because this one emitted no ::hydra:test:total:: marker.
     */
    total_estimated?: boolean;
    cases?: Array<TestCase>;
};

