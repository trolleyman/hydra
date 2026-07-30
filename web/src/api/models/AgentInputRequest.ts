/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
export type AgentInputRequest = {
    /**
     * Text to send to the agent's stdin (a newline is appended automatically)
     */
    text: string;
    /**
     * Why this message exists, when the user did not type it - "review_comments", "review_resolved", "review_unresolved", "tests_failed", "fix_conflicts", "review_thread", "fix_test". Absent for anything typed in the composer. It rides through to the chat event so the transcript can mark an automated turn as such; the agent sees only the text, which is why those messages also carry a "[Hydra]" prefix.
     */
    origin?: string;
};

