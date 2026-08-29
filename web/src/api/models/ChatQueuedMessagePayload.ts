/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
/**
 * A message the daemon is holding because a turn was running. It lives in the queue projection only; when it drains it becomes a durable user_message carrying the same id.
 */
export type ChatQueuedMessagePayload = {
    id?: string;
    status?: string;
    content?: Record<string, any>;
    /**
     * Why this message exists when the user did not type it.
     */
    origin?: string;
};

