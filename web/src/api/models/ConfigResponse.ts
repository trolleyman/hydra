/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { AgentConfig } from './AgentConfig';
import type { ArtifactScript } from './ArtifactScript';
import type { ServiceScript } from './ServiceScript';
export type ConfigResponse = {
    defaults: AgentConfig;
    agents: Record<string, AgentConfig>;
    /**
     * Per-project visual-artifact generation scripts ([[artifacts]] in config.toml)
     */
    artifacts?: Array<ArtifactScript> | null;
    /**
     * Per-project long-running supervised commands ([[services]] in config.toml)
     */
    services?: Array<ServiceScript> | null;
    /**
     * Max visual-artifact generations that run at once, across foreground (a user viewing a diff) and background (proactive pre-generation) work (artifact_concurrency in config.toml). Generations can be heavy (a full build per ref, RAM-hungry tooling like emulators), so this caps parallelism — lower it for memory-hungry generators. Foreground requests are served before queued background ones; a running generation is never preempted. Null/absent uses the built-in default.
     */
    artifact_concurrency?: number | null;
    /**
     * Built-in default pre-prompt always prepended to agent prompts (read-only)
     */
    default_pre_prompt?: string;
};

