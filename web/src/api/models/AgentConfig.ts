/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { PolicyConfig } from './PolicyConfig';
import type { SandboxConfig } from './SandboxConfig';
export type AgentConfig = {
    sandbox?: SandboxConfig | null;
    policy?: PolicyConfig | null;
    pre_prompt?: string | null;
    /**
     * Enable Claude Code's fullscreen (alternate-screen) rendering. Claude only; off by default so the web terminal keeps its native scrollbar and select-to-copy.
     */
    fullscreen?: boolean | null;
};

