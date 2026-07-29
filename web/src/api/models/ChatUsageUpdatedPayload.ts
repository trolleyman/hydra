/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
/**
 * Token accounting. One carrying a message_id opens a message's count; the rest tick it up, which is what the live working indicator counts.
 */
export type ChatUsageUpdatedPayload = {
    message_id?: string;
    usage?: Record<string, any>;
};

