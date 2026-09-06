/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { ChatShellResult } from './ChatShellResult';
import type { MessageOrigin } from './MessageOrigin';
import type { MessageReason } from './MessageReason';
/**
 * A user turn. Hydra records this at the input boundary.
 */
export type ChatUserMessagePayload = {
    /**
     * The client-generated id, so a queued bubble reconciles to it.
     */
    id?: string;
    /**
     * Content blocks, or a bare string for a provider command echo.
     */
    content?: Record<string, any>;
    shell?: ChatShellResult;
    /**
     * Who caused this turn when it was not typed in the composer. Drives the chat's attribution marker; the agent sees only the text.
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

