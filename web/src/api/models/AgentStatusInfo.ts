/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { AgentStatus } from './AgentStatus';
export type AgentStatusInfo = {
    status: AgentStatus;
    /**
     * The hook event that triggered this status (SessionStart, Stop, SessionEnd, or polling)
     */
    event?: string;
    /**
     * ISO 8601 timestamp of when the status was set
     */
    timestamp: string;
    /**
     * Last assistant message (present on turn-end and notification events)
     */
    last_message?: string;
    /**
     * Session end reason (only present on SessionEnd events)
     */
    reason?: string;
    /**
     * Short human-readable description of the agent's current action, derived from status_log.jsonl (present while running)
     */
    activity?: string;
    /**
     * True when last_message is a question/plan the agent is presenting to the user via a user-input tool (e.g. AskUserQuestion), rather than a closing message. The UI uses this to avoid marking it as a suggested next message.
     */
    last_message_is_question?: boolean;
};

