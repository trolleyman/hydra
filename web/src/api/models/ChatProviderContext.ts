/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { ChatProviderEntry } from './ChatProviderEntry';
/**
 * What a provider-derived display event carries besides its own fields: who produced it and where it belongs. Sidechain events are a sub-agent's own steps, folded into that sub-agent's card rather than the main flow.
 */
export type ChatProviderContext = {
    /**
     * The provider's id for the record this came from.
     */
    uuid?: string;
    sidechain?: boolean;
    /**
     * The sub-agent whose step this is.
     */
    agent_id?: string;
    /**
     * The tool call this belongs under.
     */
    parent_item_id?: string;
    stop_reason?: string;
    /**
     * Where the provider says its shell was left.
     */
    cwd?: string;
    /**
     * Provider token accounting; the shape differs per provider.
     */
    usage?: Record<string, any>;
    entry?: ChatProviderEntry;
};

