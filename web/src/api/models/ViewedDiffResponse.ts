/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { DiffFile } from './DiffFile';
export type ViewedDiffResponse = {
    files: Array<DiffFile>;
    /**
     * Paths whose saved blob is unavailable or whose delta could not be produced.
     */
    failed_paths: Array<string>;
};

