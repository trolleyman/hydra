/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { AgentConfig } from './AgentConfig';
export type ConfigResponse = {
    defaults: AgentConfig;
    agents: Record<string, AgentConfig>;
    /**
     * Built-in default Dockerfiles for each agent type (read-only)
     */
    default_dockerfiles?: Record<string, string>;
};

