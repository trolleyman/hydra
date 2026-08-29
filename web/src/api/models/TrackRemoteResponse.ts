/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
export type TrackRemoteResponse = {
    /**
     * The configured local remote name (e.g. "hydra-agents").
     */
    remote: string;
    /**
     * Whether the checkout already has a local branch named after the head. Existing branches should be checked out directly; only a missing branch should be created with `git checkout -t <remote>/<head-id>`.
     */
    local_branch_exists: boolean;
};

