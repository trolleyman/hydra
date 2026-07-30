/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
/**
 * Where a Bash command left the agent's shell, read from the provider's own transcript rather than inferred from the script. The Bash tool runs ONE shell per session, so this is the anchor the client's fallback walk (web/src/lib/shellCwd.ts) cannot get right on its own: it only ever sees the page of history that is loaded.
 */
export type ChatShellCwdPayload = {
    tool_use_id?: string;
    /**
     * The directory the shell was in AFTER that command.
     */
    cwd?: string;
};

