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
     * Git commit embedded in the running server binary, when available.
     */
    git_commit?: string;
    /**
     * Absolute directory containing the running server's SQLite database.
     */
    database_directory?: string;
    /**
     * Native desktop shell compatibility protocol.
     */
    desktop_protocol?: number;
    /**
     * Backend build identity displayed in compatibility errors.
     */
    build_id?: string;
    /**
     * Host operating system reported by the backend.
     */
    runtime_os?: string;
    /**
     * Whether the native sandbox backend required for ordinary heads is available.
     */
    sandbox_available?: boolean;
    /**
     * Why native sandboxing is unavailable or degraded.
     */
    sandbox_detail?: string | null;
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

