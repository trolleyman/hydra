/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { ChatEventEnvelope } from './ChatEventEnvelope';
import type { ChatProviderContext } from './ChatProviderContext';
import type { ChatSubagentPayload } from './ChatSubagentPayload';
export type SubagentCompletedEvent = (ChatEventEnvelope & {
    type: SubagentCompletedEvent.type;
    payload: (ChatProviderContext & ChatSubagentPayload);
});
export namespace SubagentCompletedEvent {
    export enum type {
        SUBAGENT_COMPLETED = 'subagent_completed',
    }
}

