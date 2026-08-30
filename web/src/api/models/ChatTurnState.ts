/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
export type ChatTurnState = {
    id?: string;
    status?: string;
    /**
     * Wall-clock time the current turn started. Present only while the turn is running, so a newly attached client can render its elapsed time from the true start rather than from navigation.
     */
    started_at?: string;
};

