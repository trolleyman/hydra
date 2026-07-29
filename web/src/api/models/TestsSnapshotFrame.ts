/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { TestRunResult } from './TestRunResult';
/**
 * Every runner's current verdict, sent once on connect.
 */
export type TestsSnapshotFrame = {
    type: 'snapshot';
    runners: Array<TestRunResult>;
};

