/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { ChatQueuedMessage } from './ChatQueuedMessage';
/**
 * The daemon's authoritative snapshot of still-queued messages, sent after replay_done and on reconnect.
 */
export type ChatQueueFrame = {
    type: 'queue';
    messages: Array<ChatQueuedMessage>;
};

