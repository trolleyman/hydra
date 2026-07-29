/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { ChatEvent } from './ChatEvent';
/**
 * One sub-agent's full step history, answering load_subagent. Not paginated: a sub-agent's steps may sit entirely outside the loaded main-conversation window.
 */
export type ChatSubagentEventsFrame = {
    type: 'subagent_events';
    agentId: string;
    events: Array<ChatEvent>;
};

