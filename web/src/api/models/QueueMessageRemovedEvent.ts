/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { ChatEventEnvelope } from './ChatEventEnvelope';
import type { ChatQueueMessageRemovedPayload } from './ChatQueueMessageRemovedPayload';
export type QueueMessageRemovedEvent = (ChatEventEnvelope & {
    type: QueueMessageRemovedEvent.type;
    payload: ChatQueueMessageRemovedPayload;
});
export namespace QueueMessageRemovedEvent {
    export enum type {
        QUEUE_MESSAGE_REMOVED = 'queue_message_removed',
    }
}

