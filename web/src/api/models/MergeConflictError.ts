/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { ErrorResponse } from './ErrorResponse';
export type MergeConflictError = (ErrorResponse & {
    error?: MergeConflictError.error;
    /**
     * For uncommitted_changes, the destination files with uncommitted local changes that the merge would overwrite.
     */
    conflicting_files?: Array<string>;
});
export namespace MergeConflictError {
    export enum error {
        MERGE_CONFLICT = 'merge_conflict',
        UNCOMMITTED_CHANGES = 'uncommitted_changes',
        CONFLICT = 'conflict',
    }
}

