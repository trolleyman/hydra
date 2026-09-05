/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
export type CodexUsageResponse = {
    /**
     * True when a usable usage snapshot was obtained.
     */
    available: boolean;
    /**
     * Why usage is unavailable (CLI missing, unsupported authentication, parse failure, ...).
     */
    error?: string | null;
    /**
     * When the snapshot was probed.
     */
    captured_at?: string;
    /**
     * Percent used (0-100) for the shortest Codex rate-limit window shorter than one week, when available across the account's limit groups.
     */
    session_percent_used?: number | null;
    /**
     * When the selected short Codex rate-limit window resets.
     */
    session_resets_at?: string | null;
    /**
     * Display label for the selected short Codex rate-limit window.
     */
    session_reset_text?: string | null;
    /**
     * Percent used (0-100) for the shortest week-or-longer Codex window, choosing the most constrained matching limit group.
     */
    weekly_percent_used?: number | null;
    /**
     * Display label for the selected week-or-longer Codex rate-limit window.
     */
    weekly_reset_text?: string | null;
};

