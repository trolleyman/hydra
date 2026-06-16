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
     * Unix time (seconds) the earliest in-flight side started, so the UI can show how long it has been running. Only set while status is "generating".
     */
    started_at?: number | null;
    /**
     * Latest progress line of the in-flight LEFT (before) generation. Taken from `::hydra:progress::` marker lines the script emits, falling back to the latest stdout line until the first marker is seen. Only set while that side is generating.
     */
    left_progress?: string | null;
    /**
     * As left_progress, for the RIGHT (after) generation.
     */
    right_progress?: string | null;
    /**
     * Captured stdout+stderr lines of the in-flight LEFT (before) generation, surfaced as a live log. Only populated while that side is generating; once settled, fetch left_log_url instead.
     */
    left_log?: Array<ArtifactLogLine> | null;
    /**
     * As left_log, for the RIGHT (after) generation.
     */
    right_log?: Array<ArtifactLogLine> | null;
    /**
     * URL to fetch the persisted build log of the LEFT (before) side once it has settled (ready or error), so the log can be reopened after generation finishes. Null while generating or if no log was captured.
     */
    left_log_url?: string | null;
    /**
     * As left_log_url, for the RIGHT (after) side.
     */
    right_log_url?: string | null;
    files: Array<ArtifactFile>;
};
export namespace ArtifactSet {
    export enum status {
        READY = 'ready',
        GENERATING = 'generating',
        ERROR = 'error',
    }
}

