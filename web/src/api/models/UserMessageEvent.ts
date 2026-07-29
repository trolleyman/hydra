/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { ChatEventEnvelope } from './ChatEventEnvelope';
import type { ChatProviderContext } from './ChatProviderContext';
import type { ChatUserMessagePayload } from './ChatUserMessagePayload';
export type UserMessageEvent = (ChatEventEnvelope & {
    type: UserMessageEvent.type;
    payload: (ChatProviderContext & ChatUserMessagePayload);
});
export namespace UserMessageEvent {
    export enum type {
        USER_MESSAGE = 'user_message',
    }
}

