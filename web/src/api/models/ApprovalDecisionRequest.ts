/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
export type ApprovalDecisionRequest = {
    /**
     * The user's verdict for the parked tool call
     */
    decision: ApprovalDecisionRequest.decision;
    /**
     * When true and decision is allow, persist the server/host to the trusted config's allow-list so future launches don't ask again
     */
    remember?: boolean;
};
export namespace ApprovalDecisionRequest {
    /**
     * The user's verdict for the parked tool call
     */
    export enum decision {
        ALLOW = 'allow',
        DENY = 'deny',
    }
}

