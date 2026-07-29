/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { ChatEventEnvelope } from './ChatEventEnvelope';
import type { ChatNoticePayload } from './ChatNoticePayload';
import type { ChatProviderContext } from './ChatProviderContext';
export type NoticeEvent = (ChatEventEnvelope & {
    type: NoticeEvent.type;
    payload: (ChatProviderContext & ChatNoticePayload);
});
export namespace NoticeEvent {
    export enum type {
        NOTICE = 'notice',
    }
}

