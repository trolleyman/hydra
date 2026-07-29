/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { ArtifactsFileFrame } from './ArtifactsFileFrame';
import type { ArtifactsLogFrame } from './ArtifactsLogFrame';
import type { ArtifactsProgressFrame } from './ArtifactsProgressFrame';
import type { ArtifactsSetFrame } from './ArtifactsSetFrame';
import type { ArtifactsSnapshotFrame } from './ArtifactsSnapshotFrame';
/**
 * One server-to-client frame on the artifacts socket.
 */
export type ArtifactsFrame = (ArtifactsSnapshotFrame | ArtifactsSetFrame | ArtifactsLogFrame | ArtifactsProgressFrame | ArtifactsFileFrame);

