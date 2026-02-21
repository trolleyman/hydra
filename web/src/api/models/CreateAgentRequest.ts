/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
export type CreateAgentRequest = {
    prompt: string;
    aiProvider: CreateAgentRequest.aiProvider;
    sandboxTemplate?: string | null;
};
export namespace CreateAgentRequest {
    export enum aiProvider {
        CLAUDE = 'claude',
        CODEX = 'codex',
        COPILOT = 'copilot',
        GEMINI = 'gemini',
        CAGENT = 'cagent',
        KIRO = 'kiro',
        OPENCODE = 'opencode',
        OTHER = 'other',
    }
}

