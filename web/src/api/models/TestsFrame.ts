/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { TestsCountsFrame } from './TestsCountsFrame';
import type { TestsLogFrame } from './TestsLogFrame';
import type { TestsProgressFrame } from './TestsProgressFrame';
import type { TestsRunnerFrame } from './TestsRunnerFrame';
import type { TestsSnapshotFrame } from './TestsSnapshotFrame';
/**
 * One server-to-client frame on the tests socket.
 */
export type TestsFrame = (TestsSnapshotFrame | TestsRunnerFrame | TestsLogFrame | TestsProgressFrame | TestsCountsFrame);

