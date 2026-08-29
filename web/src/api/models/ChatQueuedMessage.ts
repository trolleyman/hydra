/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
/**
 * A message held daemon-side because a turn was running. It lives only in the queue projection until it drains, at which point it becomes a durable user_message carrying the same id.
 */
export type ChatQueuedMessage = {
    /**
     * The client-generated id, used to reconcile the pending bubble.
     */
    id: string;
    content: Array<Record<string, any>>;
    /**
     * Why this message exists when the user did not type it.
     */
    origin?: string;
};

