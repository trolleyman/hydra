/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { ArtifactLogLine } from './ArtifactLogLine';
import type { ArtifactSide } from './ArtifactSide';
/**
 * One captured log line from a running generation.
 */
export type ArtifactsLogFrame = {
    type: 'log';
    script: string;
    side: ArtifactSide;
    line: ArtifactLogLine;
};

