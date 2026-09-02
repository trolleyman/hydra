/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { MessageOrigin } from './MessageOrigin';
import type { MessageReason } from './MessageReason';
/**
 * A message held daemon-side because a turn was running. It lives only in the queue projection until it drains, at which point it becomes a durable user_message carrying the same id.
 */
export type ChatQueuedMessage = {
    /**
     * The client-generated id, used to reconcile the pending bubble.
     */
    id: string;
    content: Array<Record<string, any>>;
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

