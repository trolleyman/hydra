/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { MessageOrigin } from './MessageOrigin';
import type { MessageReason } from './MessageReason';
export type AgentInputRequest = {
    /**
     * Text to send to the agent's stdin (a newline is appended automatically)
     */
    text: string;
    /**
     * Who caused this message when the user did not type it. Browser actions use "button"; server automation uses "hydra". Absent for composer input.
     */
    origin?: MessageOrigin;
    /**
     * Optional context for the button action or Hydra automation.
     */
    reason?: MessageReason;
};

