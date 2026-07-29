/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { ChatEventEnvelope } from './ChatEventEnvelope';
import type { ChatQueuedMessagePayload } from './ChatQueuedMessagePayload';
export type QueuedMessageEvent = (ChatEventEnvelope & {
    type: QueuedMessageEvent.type;
    payload: ChatQueuedMessagePayload;
});
export namespace QueuedMessageEvent {
    export enum type {
        QUEUED_MESSAGE = 'queued_message',
    }
}

