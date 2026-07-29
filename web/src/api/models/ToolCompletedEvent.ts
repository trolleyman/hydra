/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { ChatEventEnvelope } from './ChatEventEnvelope';
import type { ChatProviderContext } from './ChatProviderContext';
import type { ChatToolCompletedPayload } from './ChatToolCompletedPayload';
export type ToolCompletedEvent = (ChatEventEnvelope & {
    type: ToolCompletedEvent.type;
    payload: (ChatProviderContext & ChatToolCompletedPayload);
});
export namespace ToolCompletedEvent {
    export enum type {
        TOOL_COMPLETED = 'tool_completed',
    }
}

