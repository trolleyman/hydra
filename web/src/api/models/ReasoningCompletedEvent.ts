/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { ChatEventEnvelope } from './ChatEventEnvelope';
import type { ChatProviderContext } from './ChatProviderContext';
import type { ChatReasoningCompletedPayload } from './ChatReasoningCompletedPayload';
export type ReasoningCompletedEvent = (ChatEventEnvelope & {
    type: ReasoningCompletedEvent.type;
    payload: (ChatProviderContext & ChatReasoningCompletedPayload);
});
export namespace ReasoningCompletedEvent {
    export enum type {
        REASONING_COMPLETED = 'reasoning_completed',
    }
}

