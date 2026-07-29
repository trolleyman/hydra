/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { ArtifactSide } from './ArtifactSide';
/**
 * The header progress line changed for one side of a script.
 */
export type ArtifactsProgressFrame = {
    type: 'progress';
    script: string;
    side: ArtifactSide;
    progress: string;
};

