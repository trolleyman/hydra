/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { ChatContentStreamPayload } from './ChatContentStreamPayload';
import type { ChatEventEnvelope } from './ChatEventEnvelope';
import type { ChatProviderContext } from './ChatProviderContext';
export type ContentStreamCompletedEvent = (ChatEventEnvelope & {
    type: ContentStreamCompletedEvent.type;
    payload: (ChatProviderContext & ChatContentStreamPayload);
});
export namespace ContentStreamCompletedEvent {
    export enum type {
        CONTENT_STREAM_COMPLETED = 'content_stream_completed',
    }
}

