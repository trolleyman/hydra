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
     * Whether the server is running in development mode
     */
    development?: boolean;
};

