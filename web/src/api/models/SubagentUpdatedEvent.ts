/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { ChatEventEnvelope } from './ChatEventEnvelope';
import type { ChatProviderContext } from './ChatProviderContext';
import type { ChatSubagentPayload } from './ChatSubagentPayload';
export type SubagentUpdatedEvent = (ChatEventEnvelope & {
    type: SubagentUpdatedEvent.type;
    payload: (ChatProviderContext & ChatSubagentPayload);
});
export namespace SubagentUpdatedEvent {
    export enum type {
        SUBAGENT_UPDATED = 'subagent_updated',
    }
}

