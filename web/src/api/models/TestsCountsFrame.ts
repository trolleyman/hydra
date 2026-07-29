/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { TestsCounts } from './TestsCounts';
/**
 * Running totals for one runner, mid-run.
 */
export type TestsCountsFrame = {
    type: 'counts';
    name: string;
    counts: TestsCounts;
};

