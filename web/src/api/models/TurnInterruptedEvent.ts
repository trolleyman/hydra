/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { ChatEventEnvelope } from './ChatEventEnvelope';
import type { ChatProviderContext } from './ChatProviderContext';
import type { ChatTurnPayload } from './ChatTurnPayload';
export type TurnInterruptedEvent = (ChatEventEnvelope & {
    type: TurnInterruptedEvent.type;
    payload: (ChatProviderContext & ChatTurnPayload);
});
export namespace TurnInterruptedEvent {
    export enum type {
        TURN_INTERRUPTED = 'turn_interrupted',
    }
}

