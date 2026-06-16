/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
export type RepositoryBranch = {
    /**
     * Branch name (e.g. main, hydra/my-task)
     */
    name: string;
    /**
     * True for Hydra agent branches (hydra*), which are listed first
     */
    is_agent: boolean;
    /**
     * True for the repository's currently checked-out branch (HEAD)
     */
    is_current: boolean;
};

