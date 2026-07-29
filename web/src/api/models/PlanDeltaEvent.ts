/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { ChatEventEnvelope } from './ChatEventEnvelope';
import type { ChatItemDeltaPayload } from './ChatItemDeltaPayload';
import type { ChatProviderContext } from './ChatProviderContext';
export type PlanDeltaEvent = (ChatEventEnvelope & {
    type: PlanDeltaEvent.type;
    payload: (ChatProviderContext & ChatItemDeltaPayload);
});
export namespace PlanDeltaEvent {
    export enum type {
        PLAN_DELTA = 'plan_delta',
    }
}

