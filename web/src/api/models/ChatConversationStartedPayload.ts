/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
/**
 * The provider announced its session.
 */
export type ChatConversationStartedPayload = {
    conversation_id?: string;
    model?: string;
    /**
     * "none" means subscription auth, so turn footers hide the notional cost.
     */
    api_key_source?: string;
    slash_commands?: Array<string>;
};

