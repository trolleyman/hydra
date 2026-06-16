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
     * Bash script run inside the sandbox once, when the agent is first spawned — not on resume or for bash shells (e.g. `mise trust`)
     */
    pre_spawn_script?: string | null;
    network?: NetworkConfig | null;
};

