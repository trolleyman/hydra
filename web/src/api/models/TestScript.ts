/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { CachedRunPolicy } from './CachedRunPolicy';
import type { SandboxedScriptDefinition } from './SandboxedScriptDefinition';
export type TestScript = (SandboxedScriptDefinition & CachedRunPolicy & {
    /**
     * Unique label, also used as the cache directory.
     */
    name: string;
    /**
     * Result input format - junit (default) or stdout marker streaming.
     */
    type?: string | null;
});

