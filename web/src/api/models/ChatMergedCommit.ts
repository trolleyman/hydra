/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
/**
 * One commit a merge brought in, previewed in the merge chip.
 */
export type ChatMergedCommit = {
    sha?: string;
    short_sha?: string;
    subject?: string;
    author_name?: string;
    timestamp?: string;
    /**
     * Number of lines added by the commit relative to its first parent
     */
    additions?: number;
    /**
     * Number of lines removed by the commit relative to its first parent
     */
    deletions?: number;
};

