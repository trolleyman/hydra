/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
/**
 * The block a response is in the middle of producing, accumulated from every delta no completed message has settled yet. Derived on read, so a client attaching mid-response renders the whole partial block rather than the tail it happens to catch live.
 */
export type ChatStreamState = {
    kind: ChatStreamState.kind;
    message_id?: string;
    text: string;
};
export namespace ChatStreamState {
    export enum kind {
        TEXT = 'text',
        THINKING = 'thinking',
    }
}

