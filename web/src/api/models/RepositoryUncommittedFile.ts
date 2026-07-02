/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
export type RepositoryUncommittedFile = {
    /**
     * Repo-relative path of the uncommitted file
     */
    path: string;
    /**
     * One of modified|added|deleted|renamed|copied|conflicted|untracked
     */
    status: string;
};

