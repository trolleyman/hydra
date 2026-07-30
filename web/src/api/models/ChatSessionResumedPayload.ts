/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
/**
 * The head's agent process was replaced and its conversation restored - a daemon restart, or an attach after the process exited. Recorded because nothing in the provider's own stream marks it: `--continue` reuses the session id, so its second `conversation_started` dedups against the first and never reaches a client. Everything the old process owned is gone, notably the Bash tool's ONE persistent shell, which starts again at the worktree (see web/src/lib/shellCwd.ts).
 */
export type ChatSessionResumedPayload = {
    /**
     * Where the new process - and so its new shell - starts.
     */
    worktree?: string;
};

