/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
export type ChatSubagentState = {
    id: string;
    /**
     * The sub-agent that spawned this one; empty for a main-agent spawn.
     */
    parent_id?: string;
    /**
     * The tool call that spawned it, so the chat folds it into that card.
     */
    parent_item_id?: string;
    agent_type?: string;
    description?: string;
    prompt?: string;
    status?: string;
    activity?: string;
};

