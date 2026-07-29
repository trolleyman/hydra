/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { ChatProviderContext } from './ChatProviderContext';
export type ChatInteractionPayload = (ChatProviderContext & {
    provider?: string;
    request_id?: string;
    /**
     * The provider's own request, forwarded verbatim.
     */
    interaction?: Record<string, any>;
});

