/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { SandboxedScriptDefinition } from './SandboxedScriptDefinition';
export type PreviewScript = (SandboxedScriptDefinition & {
    /**
     * Unique label, shown in the agent page's Previews row.
     */
    name: string;
    /**
     * Teardown after this long with zero in-flight requests (0 = default 300).
     */
    idle_timeout_sec?: number;
    /**
     * Max seconds from spawn to ready, builds included (0 = default 900).
     */
    ready_timeout_sec?: number;
});

