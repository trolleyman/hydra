/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { ArtifactFile } from './ArtifactFile';
import type { ArtifactLogLine } from './ArtifactLogLine';
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
    /**
     * Latest stdout line of an in-flight generation (only set while status is "generating"), surfaced as live progress.
     */
    progress?: string | null;
    /**
     * Unix time (seconds) the in-flight generation started, so the UI can show how long it has been running. Only set while status is "generating".
     */
    started_at?: number | null;
    /**
     * Captured stdout+stderr lines of an in-flight generation (only populated while status is "generating"), surfaced as a live log.
     */
    log?: Array<ArtifactLogLine> | null;
    files: Array<ArtifactFile>;
};
export namespace ArtifactSet {
    export enum status {
        READY = 'ready',
        GENERATING = 'generating',
        ERROR = 'error',
    }
}

