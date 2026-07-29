/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { ChatEventEnvelope } from './ChatEventEnvelope';
import type { ChatProviderContext } from './ChatProviderContext';
import type { ChatTurnPayload } from './ChatTurnPayload';
export type TurnCompletedEvent = (ChatEventEnvelope & {
    type: TurnCompletedEvent.type;
    payload: (ChatProviderContext & ChatTurnPayload);
});
export namespace TurnCompletedEvent {
    export enum type {
        TURN_COMPLETED = 'turn_completed',
    }
}

