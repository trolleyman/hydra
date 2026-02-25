/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { CommitInfo } from './CommitInfo';
import type { DiffFile } from './DiffFile';
export type DiffResponse = {
    files: Array<DiffFile>;
    /**
     * The base ref used for this diff
     */
    base_ref: string;
    /**
     * The head ref used for this diff
     */
    head_ref: string;
    /**
     * Details of the base commit (if a specific commit SHA was given)
     */
    base_commit?: CommitInfo | null;
    /**
     * Details of the head commit
     */
    head_commit?: CommitInfo | null;
};

