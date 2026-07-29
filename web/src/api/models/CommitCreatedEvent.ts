/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { ChatCommitCreatedPayload } from './ChatCommitCreatedPayload';
import type { ChatEventEnvelope } from './ChatEventEnvelope';
export type CommitCreatedEvent = (ChatEventEnvelope & {
    type: CommitCreatedEvent.type;
    payload: ChatCommitCreatedPayload;
});
export namespace CommitCreatedEvent {
    export enum type {
        COMMIT_CREATED = 'commit_created',
    }
}

