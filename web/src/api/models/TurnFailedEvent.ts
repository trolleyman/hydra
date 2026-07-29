/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { ChatEventEnvelope } from './ChatEventEnvelope';
import type { ChatProviderContext } from './ChatProviderContext';
import type { ChatTurnPayload } from './ChatTurnPayload';
export type TurnFailedEvent = (ChatEventEnvelope & {
    type: TurnFailedEvent.type;
    payload: (ChatProviderContext & ChatTurnPayload);
});
export namespace TurnFailedEvent {
    export enum type {
        TURN_FAILED = 'turn_failed',
    }
}

