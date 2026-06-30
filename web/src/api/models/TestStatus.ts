/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
/**
 * running = a run is in flight; passing/failing/errored = settled verdict; stale = a cached verdict exists but predates the current commit; none = no tests configured or never run. (A per-runner TestRunResult only ever uses running/passing/failing/errored; stale/none are head-summary states.)
 */
export enum TestStatus {
    TestStatusRunning = 'running',
    TestStatusPassing = 'passing',
    TestStatusFailing = 'failing',
    TestStatusErrored = 'errored',
    TestStatusStale = 'stale',
    TestStatusNone = 'none',
}
