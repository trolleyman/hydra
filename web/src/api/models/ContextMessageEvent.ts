/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { ChatContextMessagePayload } from './ChatContextMessagePayload';
import type { ChatEventEnvelope } from './ChatEventEnvelope';
import type { ChatProviderContext } from './ChatProviderContext';
export type ContextMessageEvent = (ChatEventEnvelope & {
    type: ContextMessageEvent.type;
    payload: (ChatProviderContext & ChatContextMessagePayload);
});
export namespace ContextMessageEvent {
    export enum type {
        CONTEXT_MESSAGE = 'context_message',
    }
}

