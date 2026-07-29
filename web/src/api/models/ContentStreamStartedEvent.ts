/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { ChatContentStreamPayload } from './ChatContentStreamPayload';
import type { ChatEventEnvelope } from './ChatEventEnvelope';
import type { ChatProviderContext } from './ChatProviderContext';
export type ContentStreamStartedEvent = (ChatEventEnvelope & {
    type: ContentStreamStartedEvent.type;
    payload: (ChatProviderContext & ChatContentStreamPayload);
});
export namespace ContentStreamStartedEvent {
    export enum type {
        CONTENT_STREAM_STARTED = 'content_stream_started',
    }
}

