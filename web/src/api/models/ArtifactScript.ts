/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
/**
 * A per-project command that renders visual artifacts (e.g. screenshots) of a checkout, shown side-by-side in the diff viewer
 */
export type ArtifactScript = {
    /**
     * Unique label, also used as the cache directory
     */
    name: string;
    /**
     * Shell command run via `bash -c` in the checkout directory
     */
    command: string;
    /**
     * Max seconds the command may run (0 = built-in default)
     */
    timeout_sec?: number;
    /**
     * Run on the host with NO sandbox — full access to the machine and credentials (default false)
     */
    unsafe_host?: boolean;
    /**
     * Also delete git-ignored files (e.g. node_modules) before each run — a pristine checkout (git clean -fdx) instead of the default that keeps caches warm (-fd). Slower; only if stale ignored output can leak between commits (default false)
     */
    clean_ignored?: boolean;
    /**
     * Run the command under `set -eo pipefail` so a failing step aborts and propagates instead of being swallowed into a success (absent/null or true = strict; false = run exactly as written)
     */
    strict?: boolean | null;
    /**
     * Whether the diff viewer runs this script (absent/null or true = enabled; false = skipped)
     */
    enabled?: boolean | null;
};

