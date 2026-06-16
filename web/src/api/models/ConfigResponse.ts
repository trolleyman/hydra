/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { AgentConfig } from './AgentConfig';
import type { ArtifactScript } from './ArtifactScript';
export type ConfigResponse = {
    defaults: AgentConfig;
    agents: Record<string, AgentConfig>;
    /**
     * Per-project visual-artifact generation scripts ([[artifacts]] in config.toml)
     */
    artifacts?: Array<ArtifactScript> | null;
    /**
     * Built-in default pre-prompt always prepended to agent prompts (read-only)
     */
    default_pre_prompt?: string;
};

