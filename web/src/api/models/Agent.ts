/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
export type Agent = {
    id: string;
    projectId: string;
    name: string;
    prompt: string;
    status: Agent.status;
    branch: string;
    worktreePath: string;
    sandboxId?: string | null;
    sandboxTemplate?: string | null;
    aiProvider: Agent.aiProvider;
    createdAt: string;
    updatedAt: string;
    finishedAt?: string | null;
    logTail?: string | null;
};
export namespace Agent {
    export enum status {
        PENDING = 'pending',
        STARTING = 'starting',
        RUNNING = 'running',
        COMMITTING = 'committing',
        DONE = 'done',
        FAILED = 'failed',
        DELETED = 'deleted',
    }
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

