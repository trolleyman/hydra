/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { AgentConfig } from './AgentConfig';
export type ConfigResponse = {
    defaults: AgentConfig;
    agents: Record<string, AgentConfig>;
    features?: {
        terminal_bash?: boolean;
    };
    /**
     * Built-in default Dockerfiles for each agent type (read-only)
     */
    default_dockerfiles?: Record<string, string>;
    /**
     * Built-in default pre-prompt always prepended to agent prompts (read-only)
     */
    default_pre_prompt?: string;
};

