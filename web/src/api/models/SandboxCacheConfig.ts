/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
/**
 * One project-scoped cache; exactly one of env or path must be set
 */
export type SandboxCacheConfig = {
    /**
     * Environment variable redirected to the cache directory
     */
    env?: string | null;
    /**
     * Worktree-relative path linked to the cache directory
     */
    path?: string | null;
};

