/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { ChatConversationStartedPayload } from './ChatConversationStartedPayload';
import type { ChatEventEnvelope } from './ChatEventEnvelope';
import type { ChatProviderContext } from './ChatProviderContext';
export type ConversationStartedEvent = (ChatEventEnvelope & {
    type: ConversationStartedEvent.type;
    payload: (ChatProviderContext & ChatConversationStartedPayload);
});
export namespace ConversationStartedEvent {
    export enum type {
        CONVERSATION_STARTED = 'conversation_started',
    }
}

