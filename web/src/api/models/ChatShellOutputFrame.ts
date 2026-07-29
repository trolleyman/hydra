/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
/**
 * A live chunk of a running composer "!command", keyed by the send frame's id. Ephemeral - the durable record is the user_message it settles into.
 */
export type ChatShellOutputFrame = {
    type: 'shell_output';
    id: string;
    chunk: string;
};

