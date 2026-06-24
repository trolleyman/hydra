/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
export type RepositoryPushStatus = {
    /**
     * The repository's current branch, or null when HEAD is detached
     */
    branch?: string | null;
    /**
     * The remote a push would target (e.g. "origin"), or null if none
     */
    remote?: string | null;
    /**
     * Number of commits on the current branch not yet on the remote
     */
    ahead: number;
    /**
     * True if the repository has a remote to push to
     */
    has_remote: boolean;
    /**
     * True if there is a branch, a remote, and at least one commit to push
     */
    can_push: boolean;
};

