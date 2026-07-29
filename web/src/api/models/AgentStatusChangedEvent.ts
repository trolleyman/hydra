/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
/**
 * One agent's live status bundle changed.
 */
export type AgentStatusChangedEvent = {
    type: AgentStatusChangedEvent.type;
    agent_id: string;
    status?: string;
    activity?: string;
    last_message?: string;
    last_message_is_suggested?: boolean;
};
export namespace AgentStatusChangedEvent {
    export enum type {
        AGENT_STATUS_CHANGED = 'agent_status_changed',
    }
}

