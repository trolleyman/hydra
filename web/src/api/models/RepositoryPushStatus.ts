/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { RepositoryUncommittedChanges } from './RepositoryUncommittedChanges';
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
     * Number of commits the remote-tracking branch has that the local branch does not. Reflects the last fetch (the server fetches in the background); 0 when the branch isn't on the remote yet.
     */
    behind: number;
    /**
     * True if the repository has a remote to push to
     */
    has_remote: boolean;
    /**
     * True if there is a branch, a remote, and at least one commit to push
     */
    can_push: boolean;
    uncommitted: RepositoryUncommittedChanges;
};

