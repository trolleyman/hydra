/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { ChatEventEnvelope } from './ChatEventEnvelope';
import type { ChatProviderContext } from './ChatProviderContext';
import type { ChatToolStartedPayload } from './ChatToolStartedPayload';
export type ToolStartedEvent = (ChatEventEnvelope & {
    type: ToolStartedEvent.type;
    payload: (ChatProviderContext & ChatToolStartedPayload);
});
export namespace ToolStartedEvent {
    export enum type {
        TOOL_STARTED = 'tool_started',
    }
}

