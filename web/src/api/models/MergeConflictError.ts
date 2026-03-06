/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { ErrorResponse } from './ErrorResponse';
export type MergeConflictError = (ErrorResponse & {
    error?: MergeConflictError.error;
});
export namespace MergeConflictError {
    export enum error {
        MERGE_CONFLICT = 'merge_conflict',
    }
}

