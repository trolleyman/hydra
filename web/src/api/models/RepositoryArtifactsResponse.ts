/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { RepositoryArtifactScript } from './RepositoryArtifactScript';
export type RepositoryArtifactsResponse = {
    /**
     * The git ref the script list was read from
     */
    ref: string;
    /**
     * The enabled artifact scripts defined at this ref, sorted by name
     */
    scripts: Array<RepositoryArtifactScript>;
};

