/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
export type CommitRepositoryRequest = {
    /**
     * The commit message; must be non-blank
     */
    message: string;
    /**
     * Repo-relative paths to commit, as reported by the push-status uncommitted file list; must be non-empty
     */
    paths: Array<string>;
};

