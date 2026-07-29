/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { ArtifactFile } from './ArtifactFile';
/**
 * One output file finished and was compared mid-run, so its tile can render before the whole set settles. The client upserts it into the set by name; the authoritative `set` at settle reconciles the list.
 */
export type ArtifactsFileFrame = {
    type: 'file';
    script: string;
    file: ArtifactFile;
};

