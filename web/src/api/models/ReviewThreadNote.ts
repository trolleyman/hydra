/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
/**
 * One comment in a review thread. Local notes never reach the forge.
 */
export type ReviewThreadNote = {
    id: string;
    author?: string;
    body: string;
    url?: string;
    created_at?: string;
    /**
     * "forge" - on the PR for everyone to see; "local_only" - private to this Hydra install (an agent's reply, or a note you kept to yourself). NOTE: spelled local_only, not local, because an oapi-codegen enum value colliding with another enum's (the config scopes) silently re-prefixes BOTH enums' Go constants.
     */
    origin: ReviewThreadNote.origin;
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

