/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { ChatQueuedState } from './ChatQueuedState';
import type { ChatStreamState } from './ChatStreamState';
import type { ChatSubagentState } from './ChatSubagentState';
import type { ChatTurnState } from './ChatTurnState';
/**
 * Bounded current state, folded from the event log and checkpointed with the sequence it was folded through. Complete messages, tool output and sub-agent transcripts stay in the paged log, so this does not grow with the conversation.
 */
export type ChatProjection = {
    version: number;
    /**
     * The sequence number this projection was folded through.
     */
    through: number;
    plan?: Array<Record<string, any>>;
    subagents?: Record<string, ChatSubagentState>;
    turn?: ChatTurnState;
    interaction?: Record<string, any>;
    model?: string;
    /**
     * The "/" autocomplete list the provider advertised on init. Persisted so it survives a resume - the list is only emitted on the live init line, never in the transcript.
     */
    slash_commands?: Array<string>;
    usage?: Record<string, any>;
    queue?: Record<string, ChatQueuedState>;
    /**
     * The Git HEAD the commit reconciler last observed.
     */
    head?: string;
    imports?: Record<string, number>;
    stream?: ChatStreamState;
};

