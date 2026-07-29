/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { ChatEventEnvelope } from './ChatEventEnvelope';
import type { ChatHeadChangedPayload } from './ChatHeadChangedPayload';
export type HeadObservedEvent = (ChatEventEnvelope & {
    type: HeadObservedEvent.type;
    payload: ChatHeadChangedPayload;
});
export namespace HeadObservedEvent {
    export enum type {
        HEAD_OBSERVED = 'head_observed',
    }
}

