/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
export type ViewedDiffRequest = {
    /**
     * File path to the blob SHA recorded when that file was marked viewed.
     */
    viewed_blobs: Record<string, string>;
    ignore_whitespace?: boolean;
    include_uncommitted?: boolean;
    context?: number;
    full_context?: boolean;
    max_full_changes?: number;
    max_full_lines?: number;
};

