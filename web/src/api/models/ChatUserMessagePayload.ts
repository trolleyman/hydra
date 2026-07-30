/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { ChatShellResult } from './ChatShellResult';
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
     * Why this turn exists, when the user did not type it - "review_comments", "review_resolved", "review_mention", "tests_failed", "fix_conflicts", "review_thread", "fix_test". Absent for anything typed in the composer. The test is not "did Hydra write the words" but "did the user type it", so a one-click action like Fix with agent counts as automated too. Drives the chat's automated-turn marker; the agent sees only the text, which is why those messages also carry a "[Hydra]" prefix.
     */
    origin?: string;
};

