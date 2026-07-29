/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { ChatProviderContext } from './ChatProviderContext';
export type ChatAssistantMessagePayload = (ChatProviderContext & {
    message_id?: string;
    text?: string;
    /**
     * Set when an interrupt settled the deltas received so far.
     */
    partial?: boolean;
});

