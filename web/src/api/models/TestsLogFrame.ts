/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { ArtifactLogLine } from './ArtifactLogLine';
/**
 * One captured log line from a running runner.
 */
export type TestsLogFrame = {
    type: 'log';
    name: string;
    line: ArtifactLogLine;
};

