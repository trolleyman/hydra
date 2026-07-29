/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
export type StatusResponse = {
    status?: string;
    /**
     * Error message if the sandbox backend is unavailable or misconfigured
     */
    sandbox_error?: string | null;
    version?: string;
    /**
     * Seconds since the server started
     */
    uptime_seconds?: number;
    /**
     * Absolute path to the default project root (server CWD)
     */
    project_root?: string;
    /**
     * Project ID of the default (CWD) project
     */
    default_project_id?: string;
    /**
     * Whether the server is being served out of a Hydra source checkout, which is what enables developer affordances such as the Chrome DevTools workspace endpoint.
     *
     */
    development?: boolean;
    /**
     * Whether the server can restart itself in place (re-exec). False on platforms without exec.
     *
     */
    can_restart?: boolean;
    /**
     * Whether the server can rebuild itself from source and restart into the result. Requires the daemon's project root to be a Hydra checkout with mage available.
     *
     */
    can_update?: boolean;
};

