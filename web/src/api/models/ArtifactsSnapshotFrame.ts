/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { ArtifactSet } from './ArtifactSet';
/**
 * Every script's current set, sent once on connect.
 */
export type ArtifactsSnapshotFrame = {
    type: 'snapshot';
    scripts: Array<ArtifactSet>;
};

