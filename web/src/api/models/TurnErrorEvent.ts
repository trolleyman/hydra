/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { ChatEventEnvelope } from './ChatEventEnvelope';
import type { ChatProviderContext } from './ChatProviderContext';
import type { ChatTurnPayload } from './ChatTurnPayload';
export type TurnErrorEvent = (ChatEventEnvelope & {
    type: TurnErrorEvent.type;
    payload: (ChatProviderContext & ChatTurnPayload);
});
export namespace TurnErrorEvent {
    export enum type {
        TURN_ERROR = 'turn_error',
    }
}

