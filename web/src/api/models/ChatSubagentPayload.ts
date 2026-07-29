/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
/**
 * A sub-agent's lifecycle. subagent_completed is the one completion chip. The tool call that spawned it rides in ChatProviderContext's parent_item_id, which is the same field.
 */
export type ChatSubagentPayload = {
    id?: string;
    parent_id?: string;
    agent_type?: string;
    description?: string;
    prompt?: string;
    status?: string;
};

