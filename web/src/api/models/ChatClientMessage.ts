/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
/**
 * One client-to-server frame on a chat-mode socket. Flat rather than a union: `type` selects which of the optional fields carry meaning.
 */
export type ChatClientMessage = {
    type: ChatClientMessage.type;
    /**
     * The client-generated id of a user_message, or the dequeue/shell_stop target, so a queued message can be reconciled and recalled.
     */
    id?: string;
    /**
     * Set on a user_message sent while a turn runs: the daemon HOLDS it rather than delivering now, and drains it when the turn ends.
     */
    queued?: boolean;
    /**
     * The history cursor of a load_events_before request - the daemon returns the batch older than it.
     */
    cursor?: string;
    limit?: number;
    /**
     * A user_message's content blocks, forwarded to the provider verbatim.
     */
    content?: Array<Record<string, any>>;
    /**
     * The set_model target (a provider alias like "sonnet").
     */
    model?: string;
    /**
     * The shell command of a shell_command frame (the text after the composer's leading "!"), run in the head's sandbox.
     */
    command?: string;
    /**
     * A control_response payload, e.g. AskUserQuestion answers.
     */
    response?: Record<string, any>;
    /**
     * The output-file path of a task_output request, as the SANDBOXED agent saw it.
     */
    file?: string;
    /**
     * The sub-agent whose full step history the client wants.
     */
    sub_id?: string;
};
export namespace ChatClientMessage {
    export enum type {
        USER_MESSAGE = 'user_message',
        INTERRUPT = 'interrupt',
        SET_MODEL = 'set_model',
        CONTROL_RESPONSE = 'control_response',
        SHELL_COMMAND = 'shell_command',
        SHELL_STOP = 'shell_stop',
        DEQUEUE = 'dequeue',
        LOAD_EVENTS_BEFORE = 'load_events_before',
        LOAD_SUBAGENT = 'load_subagent',
        TASK_OUTPUT = 'task_output',
    }
}

