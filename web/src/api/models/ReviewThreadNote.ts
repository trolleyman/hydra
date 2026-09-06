/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { ReviewSuggestion } from './ReviewSuggestion';
/**
 * One comment in a review thread. Local notes never reach the forge.
 */
export type ReviewThreadNote = {
    id: string;
    /**
     * The note's handle in the head's ONE numbering sequence, shared with Hydra's own comments so "fix
     */
    number?: number;
    read?: boolean;
    /**
     * The author's picture, hosted by the FORGE. Hydra stores no images and proxies nothing - the browser loads this directly, and a failure falls back to a monogram.
     */
    avatar_url?: string;
    author?: string;
    body: string;
    url?: string;
    created_at?: string;
    /**
     * "forge" - on the PR for everyone to see; "local_only" - private to this Hydra install (an agent's reply, or a note you kept to yourself). NOTE: spelled local_only, not local, because an oapi-codegen enum value colliding with another enum's (the config scopes) silently re-prefixes BOTH enums' Go constants.
     */
    origin: ReviewThreadNote.origin;
    suggestion?: ReviewSuggestion;
};
export namespace ReviewThreadNote {
    /**
     * "forge" - on the PR for everyone to see; "local_only" - private to this Hydra install (an agent's reply, or a note you kept to yourself). NOTE: spelled local_only, not local, because an oapi-codegen enum value colliding with another enum's (the config scopes) silently re-prefixes BOTH enums' Go constants.
     */
    export enum origin {
        FORGE = 'forge',
        LOCAL_ONLY = 'local_only',
    }
}

