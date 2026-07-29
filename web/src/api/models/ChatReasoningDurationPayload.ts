/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
/**
 * The measured duration of a thinking block. Separate from the block itself, because no provider reports it - the daemon times it.
 */
export type ChatReasoningDurationPayload = {
    message_id?: string;
    duration_ms?: number;
};

