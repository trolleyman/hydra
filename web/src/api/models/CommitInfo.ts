/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
export type CommitInfo = {
    /**
     * Full 40-character commit SHA
     */
    sha: string;
    /**
     * Abbreviated 7-character commit SHA
     */
    short_sha: string;
    /**
     * Full commit message
     */
    message: string;
    /**
     * First line of the commit message
     */
    subject?: string;
    /**
     * Full SHA of the commit's first parent, when it has one
     */
    parent_sha?: string;
    author_name: string;
    author_email: string;
    /**
     * ISO 8601 timestamp of the author date
     */
    timestamp: string;
    /**
     * Number of lines added by the commit relative to its first parent
     */
    additions: number;
    /**
     * Number of lines removed by the commit relative to its first parent
     */
    deletions: number;
};

