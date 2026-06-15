/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { SandboxConfig } from './SandboxConfig';
export type AgentConfig = {
    sandbox?: SandboxConfig | null;
    shared_mounts?: Array<string> | null;
    pre_prompt?: string | null;
    /**
     * @deprecated
     */
    dockerfile?: string | null;
    /**
     * @deprecated
     */
    dockerfile_contents?: string | null;
    /**
     * @deprecated
     */
    dockerignore_contents?: string | null;
    /**
     * @deprecated
     */
    context?: string | null;
};

