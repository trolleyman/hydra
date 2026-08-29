/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
/**
 * Fields shared by every configured command script.
 */
export type ScriptDefinition = {
    /**
     * Shell script run via `bash -c`. Written as `script` in config.toml; the older `command` key still parses and is migrated on save.
     */
    script: string;
    /**
     * Run under `set -eo pipefail` so a failing step propagates (absent/null or true = strict; false = run exactly as written).
     */
    strict?: boolean | null;
    /**
     * Whether this configured script is active (absent/null or true = enabled; false = skipped).
     */
    enabled?: boolean | null;
};

