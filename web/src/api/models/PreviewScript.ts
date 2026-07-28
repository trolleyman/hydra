/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
/**
 * A per-project command that boots a live, clickable preview of the app at a checkout ([previews.<name>] in config.toml). Hydra proxies a dedicated port to it, spawning it when its link is opened and tearing it down when idle.
 */
export type PreviewScript = {
    /**
     * Unique label, shown in the agent page's Previews row
     */
    name: string;
    /**
     * Shell script run via `bash -c` in the checkout directory. It must start a server listening on $HYDRA_PREVIEW_ADDR and stay in the foreground.
     */
    command: string;
    /**
     * Run on the host with NO sandbox - full access to the machine and credentials (default false)
     */
    unsafe_host?: boolean;
    /**
     * Run the command under `set -eo pipefail` so a failing build step aborts the spawn instead of serving a half-built tree (absent/null or true = strict)
     */
    strict?: boolean | null;
    /**
     * Whether the preview is offered on the agent page (absent/null or true = enabled; false = hidden)
     */
    enabled?: boolean | null;
    /**
     * Teardown after this long with zero in-flight proxied requests; open WebSocket/long-poll connections count as in-flight (0 = default 300).
     */
    idle_timeout_sec?: number;
    /**
     * Max seconds from spawn to ready, builds included (0 = default 900)
     */
    ready_timeout_sec?: number;
};

