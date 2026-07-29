/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { ChatEventEnvelope } from './ChatEventEnvelope';
import type { ChatInteractionPayload } from './ChatInteractionPayload';
import type { ChatProviderContext } from './ChatProviderContext';
export type InteractionResolvedEvent = (ChatEventEnvelope & {
    type: InteractionResolvedEvent.type;
    payload: (ChatProviderContext & ChatInteractionPayload);
});
export namespace InteractionResolvedEvent {
    export enum type {
        INTERACTION_RESOLVED = 'interaction_resolved',
    }
}

