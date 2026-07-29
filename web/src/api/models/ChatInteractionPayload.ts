/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
/**
 * The provider is blocked on the user (an AskUserQuestion elicitation), or that request was answered.
 */
export type ChatInteractionPayload = {
    provider?: string;
    request_id?: string;
    /**
     * The provider's own request, forwarded verbatim.
     */
    interaction?: Record<string, any>;
};

