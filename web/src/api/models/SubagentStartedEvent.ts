/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { ChatEventEnvelope } from './ChatEventEnvelope';
import type { ChatProviderContext } from './ChatProviderContext';
import type { ChatSubagentPayload } from './ChatSubagentPayload';
export type SubagentStartedEvent = (ChatEventEnvelope & {
    type: SubagentStartedEvent.type;
    payload: (ChatProviderContext & ChatSubagentPayload);
});
export namespace SubagentStartedEvent {
    export enum type {
        SUBAGENT_STARTED = 'subagent_started',
    }
}

