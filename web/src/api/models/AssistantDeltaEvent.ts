/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { ChatDeltaPayload } from './ChatDeltaPayload';
import type { ChatEventEnvelope } from './ChatEventEnvelope';
import type { ChatProviderContext } from './ChatProviderContext';
export type AssistantDeltaEvent = (ChatEventEnvelope & {
    type: AssistantDeltaEvent.type;
    payload: (ChatProviderContext & ChatDeltaPayload);
});
export namespace AssistantDeltaEvent {
    export enum type {
        ASSISTANT_DELTA = 'assistant_delta',
    }
}

