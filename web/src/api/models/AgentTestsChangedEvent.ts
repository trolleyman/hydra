/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { TestSummary } from './TestSummary';
/**
 * One agent's test counts moved mid-run, so the sidebar chips can tick without refetching the agent list.
 */
export type AgentTestsChangedEvent = {
    type: AgentTestsChangedEvent.type;
    agent_id: string;
    tests?: TestSummary;
};
export namespace AgentTestsChangedEvent {
    export enum type {
        AGENT_TESTS_CHANGED = 'agent_tests_changed',
    }
}

