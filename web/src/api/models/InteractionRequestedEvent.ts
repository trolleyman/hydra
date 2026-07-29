/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { ChatEventEnvelope } from './ChatEventEnvelope';
import type { ChatInteractionPayload } from './ChatInteractionPayload';
import type { ChatProviderContext } from './ChatProviderContext';
export type InteractionRequestedEvent = (ChatEventEnvelope & {
    type: InteractionRequestedEvent.type;
    payload: (ChatProviderContext & ChatInteractionPayload);
});
export namespace InteractionRequestedEvent {
    export enum type {
        INTERACTION_REQUESTED = 'interaction_requested',
    }
}

