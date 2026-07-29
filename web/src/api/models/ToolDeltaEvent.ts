/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { ChatEventEnvelope } from './ChatEventEnvelope';
import type { ChatItemDeltaPayload } from './ChatItemDeltaPayload';
import type { ChatProviderContext } from './ChatProviderContext';
export type ToolDeltaEvent = (ChatEventEnvelope & {
    type: ToolDeltaEvent.type;
    payload: (ChatProviderContext & ChatItemDeltaPayload);
});
export namespace ToolDeltaEvent {
    export enum type {
        TOOL_DELTA = 'tool_delta',
    }
}

