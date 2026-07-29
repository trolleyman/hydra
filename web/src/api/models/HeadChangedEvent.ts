/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { ChatEventEnvelope } from './ChatEventEnvelope';
import type { ChatHeadChangedPayload } from './ChatHeadChangedPayload';
export type HeadChangedEvent = (ChatEventEnvelope & {
    type: HeadChangedEvent.type;
    payload: ChatHeadChangedPayload;
});
export namespace HeadChangedEvent {
    export enum type {
        HEAD_CHANGED = 'head_changed',
    }
}

