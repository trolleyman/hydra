/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { ChatEventEnvelope } from './ChatEventEnvelope';
import type { ChatShellCwdPayload } from './ChatShellCwdPayload';
export type ShellCwdEvent = (ChatEventEnvelope & {
    type: ShellCwdEvent.type;
    payload: ChatShellCwdPayload;
});
export namespace ShellCwdEvent {
    export enum type {
        SHELL_CWD = 'shell_cwd',
    }
}

