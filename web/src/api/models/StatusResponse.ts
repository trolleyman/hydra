/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
export type StatusResponse = {
    status?: string;
    /**
     * Error message if there is an issue connecting to Docker
     */
    docker_error?: string | null;
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
    features?: {
        /**
         * Whether the bash terminal feature is enabled
         */
        terminal_bash?: boolean;
    };
};

