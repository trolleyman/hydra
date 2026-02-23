/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
export type ClaudeStatusInfo = {
    /**
     * Current status: starting, waiting, or ended
     */
    status: string;
    /**
     * The hook event that triggered this status (SessionStart, Stop, or SessionEnd)
     */
    event: string;
    /**
     * ISO 8601 timestamp of when the status was set
     */
    timestamp: string;
    /**
     * Last assistant message (only present on Stop events)
     */
    last_message?: string;
    /**
     * Session end reason (only present on SessionEnd events)
     */
    reason?: string;
};

