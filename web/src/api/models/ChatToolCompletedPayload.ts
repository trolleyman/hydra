/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { ChatProviderContext } from './ChatProviderContext';
export type ChatToolCompletedPayload = (ChatProviderContext & {
    id?: string;
    name?: string;
    /**
     * The provider's verbatim result blocks, when it sent any.
     */
    content?: Record<string, any>;
    /**
     * Codex reveals semantic tool fields only on completion, so a completed event can carry richer input than its start.
     */
    input?: Record<string, any>;
    output?: string;
    status?: string;
    is_error?: boolean;
    /**
     * An Edit's own structuredPatch, so the card renders a diff against the file's real line numbers rather than two loose fragments.
     */
    patch?: Record<string, any>;
});

