/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { ArtifactLogLine } from './ArtifactLogLine';
import type { RepositoryArtifactFile } from './RepositoryArtifactFile';
export type RepositoryArtifactResponse = {
    /**
     * The artifact script name
     */
    name: string;
    status: RepositoryArtifactResponse.status;
    /**
     * Set only when generation failed (status "error").
     */
    error?: string | null;
    /**
     * Unix time (seconds) generation started, so the UI can show elapsed time. Only set while generating.
     */
    started_at?: number | null;
    /**
     * Latest progress line of the in-flight generation, from `::hydra:progress::` marker lines (falling back to the latest stdout line). Only set while generating.
     */
    progress?: string | null;
    /**
     * Captured stdout+stderr lines of the in-flight generation, surfaced as a live log. Only populated while generating; once settled, fetch log_url instead.
     */
    log?: Array<ArtifactLogLine> | null;
    /**
     * URL to fetch the persisted build log once generation has settled. Null while generating or if no log was captured.
     */
    log_url?: string | null;
    files: Array<RepositoryArtifactFile>;
};
export namespace RepositoryArtifactResponse {
    export enum status {
        READY = 'ready',
        GENERATING = 'generating',
        ERROR = 'error',
    }
}

