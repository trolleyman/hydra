/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { ChatEventEnvelope } from './ChatEventEnvelope';
import type { ChatMessagesRetractedPayload } from './ChatMessagesRetractedPayload';
import type { ChatProviderContext } from './ChatProviderContext';
export type MessagesRetractedEvent = (ChatEventEnvelope & {
    type: MessagesRetractedEvent.type;
    payload: (ChatProviderContext & ChatMessagesRetractedPayload);
});
export namespace MessagesRetractedEvent {
    export enum type {
        MESSAGES_RETRACTED = 'messages_retracted',
    }
}

