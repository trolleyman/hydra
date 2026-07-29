/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { ChatEventEnvelope } from './ChatEventEnvelope';
import type { ChatUsageUpdatedPayload } from './ChatUsageUpdatedPayload';
export type UsageUpdatedEvent = (ChatEventEnvelope & {
    type: UsageUpdatedEvent.type;
    payload: ChatUsageUpdatedPayload;
});
export namespace UsageUpdatedEvent {
    export enum type {
        USAGE_UPDATED = 'usage_updated',
    }
}

