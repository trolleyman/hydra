/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { ChatEventEnvelope } from './ChatEventEnvelope';
import type { ChatPlanUpdatedPayload } from './ChatPlanUpdatedPayload';
import type { ChatProviderContext } from './ChatProviderContext';
export type PlanUpdatedEvent = (ChatEventEnvelope & {
    type: PlanUpdatedEvent.type;
    payload: (ChatProviderContext & ChatPlanUpdatedPayload);
});
export namespace PlanUpdatedEvent {
    export enum type {
        PLAN_UPDATED = 'plan_updated',
    }
}

