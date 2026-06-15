/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { ArtifactFile } from './ArtifactFile';
export type ArtifactSet = {
    /**
     * The configured artifact script name
     */
    name: string;
    status: ArtifactSet.status;
    /**
     * Whether any file differs between the two versions
     */
    changed: boolean;
    error?: string | null;
    files: Array<ArtifactFile>;
};
export namespace ArtifactSet {
    export enum status {
        READY = 'ready',
        GENERATING = 'generating',
        ERROR = 'error',
    }
}

