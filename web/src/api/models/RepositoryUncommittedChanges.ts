/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { RepositoryUncommittedFile } from './RepositoryUncommittedFile';
/**
 * Uncommitted changes in the project root's working tree. Drives the sidebar warning that config edits (e.g. the web UI writing .hydra/config.toml) are sitting uncommitted.
 */
export type RepositoryUncommittedChanges = {
    /**
     * Total number of uncommitted paths (tracked changes + untracked files)
     */
    total: number;
    /**
     * The uncommitted paths in git's status order, truncated to the first 20 when total exceeds that.
     */
    files: Array<RepositoryUncommittedFile>;
};

