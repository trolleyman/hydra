/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { ChatDeltaPayload } from './ChatDeltaPayload';
import type { ChatEventEnvelope } from './ChatEventEnvelope';
import type { ChatProviderContext } from './ChatProviderContext';
export type ReasoningDeltaEvent = (ChatEventEnvelope & {
    type: ReasoningDeltaEvent.type;
    payload: (ChatProviderContext & ChatDeltaPayload);
});
export namespace ReasoningDeltaEvent {
    export enum type {
        REASONING_DELTA = 'reasoning_delta',
    }
}

