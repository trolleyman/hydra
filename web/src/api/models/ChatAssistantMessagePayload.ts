/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
/**
 * A settled assistant message; it replaces its streamed preview.
 */
export type ChatAssistantMessagePayload = {
    message_id?: string;
    text?: string;
    /**
     * Set when an interrupt settled the deltas received so far.
     */
    partial?: boolean;
};

