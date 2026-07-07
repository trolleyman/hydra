/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { AgentConfig } from './AgentConfig';
import type { ArtifactScript } from './ArtifactScript';
import type { McpServer } from './McpServer';
import type { ReviewConfig } from './ReviewConfig';
import type { ServiceScript } from './ServiceScript';
import type { TestScript } from './TestScript';
export type ConfigResponse = {
    defaults: AgentConfig;
    agents: Record<string, AgentConfig>;
    /**
     * Read-only: candidate MCP servers discovered in the host ~/.claude.json and project .mcp.json, for populating the mcp_allowed picker. Ignored on save.
     */
    mcp_servers?: Array<McpServer> | null;
    /**
     * Per-project visual-artifact generation scripts ([[artifacts]] in config.toml)
     */
    artifacts?: Array<ArtifactScript> | null;
    /**
     * Per-project long-running supervised commands ([[services]] in config.toml)
     */
    services?: Array<ServiceScript> | null;
    /**
     * Per-project test-runner commands whose verdict gates merge ([[tests]] in config.toml)
     */
    tests?: Array<TestScript> | null;
    /**
     * Max test-runner generations that run at once (test_concurrency in config.toml). 0 = unlimited; null/absent uses the built-in default.
     */
    test_concurrency?: number | null;
    /**
     * Whether the daemon proactively re-runs a head's test suites in the background when its branch-tip verdict is missing or stale (a cached result computed for an older commit), so the verdict is ready before the tests panel is opened or the merge gate runs (test_prefetch in config.toml). When false, tests run only on open / at merge; foreground runs and test_concurrency still apply. null/absent uses the built-in default (enabled).
     */
    test_prefetch?: boolean | null;
    /**
     * Max visual-artifact generations that run at once, across foreground (a user viewing a diff) and background (proactive pre-generation) work (artifact_concurrency in config.toml). Generations can be heavy (a full build per ref, RAM-hungry tooling like emulators), so this caps parallelism - lower it for memory-hungry generators. Foreground requests are served before queued background ones; a running generation is never preempted. 0 means unlimited (no cap); null/absent uses the built-in default.
     */
    artifact_concurrency?: number | null;
    /**
     * Whether the daemon proactively pre-generates a head's artifacts in the background once its working tree settles, so a diff is ready before it is opened (artifact_prefetch in config.toml). When false, artifacts are generated only when a diff is viewed; foreground generation and artifact_concurrency still apply. null/absent uses the built-in default (enabled).
     */
    artifact_prefetch?: boolean | null;
    /**
     * Built-in default pre-prompt always prepended to agent prompts (read-only)
     */
    default_pre_prompt?: string;
    review?: ReviewConfig;
};

