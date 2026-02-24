/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { AgentStatusInfo } from './AgentStatusInfo';
export type AgentResponse = {
    id: string;
    branch_name?: string | null;
    worktree_path?: string | null;
    project_path: string;
    container_id: string;
    container_status: string;
    agent_type: string;
    pre_prompt: string;
    prompt: string;
    base_branch: string;
    /**
     * Unix timestamp (seconds) when the container was created/started; absent if no container
     */
    created_at?: number;
    agent_status?: AgentStatusInfo;
};

