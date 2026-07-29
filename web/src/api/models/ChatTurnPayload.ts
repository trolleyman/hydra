/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
/**
 * A turn boundary - the unit queue draining and head status key off.
 */
export type ChatTurnPayload = {
    id?: string;
    status?: string;
    result?: string;
    cost_usd?: number;
    /**
     * The provider's structured failure. The browser unwraps app-server's nested JSON to show its type, status and message.
     */
    error?: Record<string, any>;
};

