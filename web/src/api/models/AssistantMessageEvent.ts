/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { ChatAssistantMessagePayload } from './ChatAssistantMessagePayload';
import type { ChatEventEnvelope } from './ChatEventEnvelope';
import type { ChatProviderContext } from './ChatProviderContext';
export type AssistantMessageEvent = (ChatEventEnvelope & {
    type: AssistantMessageEvent.type;
    payload: (ChatProviderContext & ChatAssistantMessagePayload);
});
export namespace AssistantMessageEvent {
    export enum type {
        ASSISTANT_MESSAGE = 'assistant_message',
    }
}

