/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { NetworkConfig } from './NetworkConfig';
/**
 * User-editable sandbox policy, additive on top of baked-in defaults
 */
export type SandboxConfig = {
    writable_paths?: Array<string> | null;
    masked_paths?: Array<string> | null;
    restore_ro?: Array<string> | null;
    /**
     * Paths mounted copy-on-write. The agent reads the real files and may overwrite them, but writes are kept per-head and never touch the source. A worktree-relative entry (pipeline/out) is mirrored from the project root into the worktree; a home/absolute entry (~/.gradle, /opt/cache), resolved against HOME, is overlaid in place and supersedes any default writable bind on it. For large gitignored build dirs or shared tool caches too big to copy. On Linux needs an overlay-capable bwrap.
     */
    cow_paths?: Array<string> | null;
    /**
     * Additional daemon environment variable names passed into heads. Additive across config layers; values are resolved at launch and are never stored. Hydra-owned names, including every HYDRA_* variable, cannot be inherited.
     */
    inherit_env?: Array<string> | null;
    /**
     * Bash script run inside the sandbox before every agent launch - both spawn and resume - so it must be idempotent. Not run for bash shells (e.g. `mise trust`)
     */
    pre_spawn_script?: string | null;
    /**
     * Bash script run in a sandbox when a head ends, after the agent's session is killed but before its worktree is removed. Runs with the head's sandbox policy, cwd = worktree, with HYDRA_* head context + HYDRA_END_STATE. For per-head teardown such as releasing a claimed resource.
     */
    pre_exit_script?: string | null;
    network?: NetworkConfig | null;
};

