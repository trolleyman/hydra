/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { ChatEvent } from './ChatEvent';
/**
 * One page of durable history, oldest-first. Answers the initial window and every load_events_before. Paging is display-only: an older page never rewinds the state_snapshot projection.
 */
export type ChatHistoryFrame = {
    type: 'chat_history';
    events: Array<ChatEvent>;
    /**
     * The cursor to ask for the page before this one.
     */
    next_cursor?: string;
    /**
     * True once the log's beginning has been reached.
     */
    done: boolean;
};

