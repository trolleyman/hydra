/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { ChatEventEnvelope } from './ChatEventEnvelope';
import type { ChatProviderContext } from './ChatProviderContext';
import type { ChatTurnPayload } from './ChatTurnPayload';
export type TurnStartedEvent = (ChatEventEnvelope & {
    type: TurnStartedEvent.type;
    payload: (ChatProviderContext & ChatTurnPayload);
});
export namespace TurnStartedEvent {
    export enum type {
        TURN_STARTED = 'turn_started',
    }
}

