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
     * Shell script run inside the sandbox immediately before each agent is launched (e.g. `mise trust`)
     */
    pre_spawn_script?: string | null;
    network?: NetworkConfig | null;
};

