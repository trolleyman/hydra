/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { ChatEventEnvelope } from './ChatEventEnvelope';
import type { ChatUserMessageEchoedPayload } from './ChatUserMessageEchoedPayload';
export type UserMessageEchoedEvent = (ChatEventEnvelope & {
    type: UserMessageEchoedEvent.type;
    payload: ChatUserMessageEchoedPayload;
});
export namespace UserMessageEchoedEvent {
    export enum type {
        USER_MESSAGE_ECHOED = 'user_message_echoed',
    }
}

