/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { RepositoryBranch } from './RepositoryBranch';
export type RepositoryBranchesResponse = {
    /**
     * The repository's currently checked-out branch (HEAD), or "" when detached
     */
    current: string;
    /**
     * Branches ordered with Hydra agent branches first, then the rest
     */
    branches: Array<RepositoryBranch>;
};

