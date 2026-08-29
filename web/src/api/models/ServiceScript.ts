/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { ScriptDefinition } from './ScriptDefinition';
export type ServiceScript = (ScriptDefinition & {
    /**
     * Unique label, shown in the UI and logs.
     */
    name: string;
    /**
     * Run on the host with NO sandbox - needed for host devices such as /dev/kvm (default false).
     */
    host?: boolean;
    /**
     * Relaunch cap after an unexpected exit (null = default 3; 0 = never restart).
     */
    max_restarts?: number | null;
});

