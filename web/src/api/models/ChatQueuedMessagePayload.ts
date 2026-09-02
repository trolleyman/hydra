/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { MessageOrigin } from './MessageOrigin';
import type { MessageReason } from './MessageReason';
/**
 * A message the daemon is holding because a turn was running. It lives in the queue projection only; when it drains it becomes a durable user_message carrying the same id.
 */
export type ChatQueuedMessagePayload = {
    id?: string;
    status?: string;
    content?: Record<string, any>;
    /**
     * Who caused this message when it was not typed in the composer.
     */
    origin?: MessageOrigin;
    /**
     * Optional context for the button action or Hydra automation.
     */
    reason?: MessageReason;
    /**
     * The sending head when origin is "agent".
     */
    source_agent_id?: string;
};

