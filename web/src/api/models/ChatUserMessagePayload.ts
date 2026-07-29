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
};

