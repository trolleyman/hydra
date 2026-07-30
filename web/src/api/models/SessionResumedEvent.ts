/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { ChatEventEnvelope } from './ChatEventEnvelope';
import type { ChatSessionResumedPayload } from './ChatSessionResumedPayload';
export type SessionResumedEvent = (ChatEventEnvelope & {
    type: SessionResumedEvent.type;
    payload: ChatSessionResumedPayload;
});
export namespace SessionResumedEvent {
    export enum type {
        SESSION_RESUMED = 'session_resumed',
    }
}

