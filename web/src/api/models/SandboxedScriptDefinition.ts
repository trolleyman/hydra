/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { ScriptDefinition } from './ScriptDefinition';
export type SandboxedScriptDefinition = (ScriptDefinition & {
    /**
     * Run on the host with NO sandbox - full access to the machine and credentials (default false).
     */
    unsafe_host?: boolean;
});

