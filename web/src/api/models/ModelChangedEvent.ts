/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { ChatEventEnvelope } from './ChatEventEnvelope';
import type { ChatModelChangedPayload } from './ChatModelChangedPayload';
export type ModelChangedEvent = (ChatEventEnvelope & {
    type: ModelChangedEvent.type;
    payload: ChatModelChangedPayload;
});
export namespace ModelChangedEvent {
    export enum type {
        MODEL_CHANGED = 'model_changed',
    }
}

