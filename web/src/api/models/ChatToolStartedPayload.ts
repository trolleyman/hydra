/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
/**
 * A tool call.
 */
export type ChatToolStartedPayload = {
    id?: string;
    name?: string;
    /**
     * The provider's own block input, verbatim - the shape is the tool's, so this is where an agent-type-specific payload lives. Codex additionally carries its native item under `_raw`.
     */
    input?: Record<string, any>;
    /**
     * Present on Codex items; its absence is what marks a Claude block.
     */
    status?: string;
    /**
     * Whatever the tool produced, as the provider sent it - a string, an object, an error. Provider-owned, like `input`.
     */
    output?: any;
};

