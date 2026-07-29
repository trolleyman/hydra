/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { ChatEventEnvelope } from './ChatEventEnvelope';
import type { ChatReasoningDurationPayload } from './ChatReasoningDurationPayload';
export type ReasoningDurationEvent = (ChatEventEnvelope & {
    type: ReasoningDurationEvent.type;
    payload: ChatReasoningDurationPayload;
});
export namespace ReasoningDurationEvent {
    export enum type {
        REASONING_DURATION = 'reasoning_duration',
    }
}

