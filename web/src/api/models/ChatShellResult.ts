/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
/**
 * The sandboxed result of a composer "!command", carried on the user_message it settles into so the chat renders a shell card rather than a bubble.
 */
export type ChatShellResult = {
    command: string;
    output: string;
    exit_code: number;
    truncated?: boolean;
    timed_out?: boolean;
    stopped?: boolean;
};

