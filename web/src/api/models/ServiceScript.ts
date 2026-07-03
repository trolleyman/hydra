/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
/**
 * A per-project long-running command the daemon supervises while the project is registered ([[services]] in config.toml)
 */
export type ServiceScript = {
    /**
     * Unique label, shown in the UI and logs
     */
    name: string;
    /**
     * Shell command run via `bash -c` from the project root
     */
    command: string;
    /**
     * Run on the host with NO sandbox - needed for host devices the sandbox hides, e.g. /dev/kvm (default false)
     */
    host?: boolean;
    /**
     * Relaunch cap after an unexpected exit (null = default 3; 0 = never restart)
     */
    max_restarts?: number | null;
    /**
     * Run the command under `set -eo pipefail` so a failed startup step surfaces as a crash instead of a healthy process (absent/null or true = strict; false = run exactly as written)
     */
    strict?: boolean | null;
    /**
     * Whether the daemon supervises this service (absent/null or true = enabled; false = skipped)
     */
    enabled?: boolean | null;
};

