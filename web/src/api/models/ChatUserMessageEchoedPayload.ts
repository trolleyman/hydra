/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
/**
 * Reconciles a provider's echo of a message Hydra already recorded. The marker is durable on purpose: without it, two identical messages sent in separate turns cannot be paired correctly after a daemon restart.
 */
export type ChatUserMessageEchoedPayload = {
    /**
     * The sequence of the user_message this echo belongs to.
     */
    user_seq?: number;
    content?: Record<string, any>;
};

