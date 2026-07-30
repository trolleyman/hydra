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
     * Percent of the primary Codex rate-limit window used (0-100).
     */
    session_percent_used?: number | null;
    /**
     * When the primary Codex rate-limit window resets.
     */
    session_resets_at?: string | null;
    /**
     * Display label for the primary Codex rate-limit window.
     */
    session_reset_text?: string | null;
    /**
     * Percent of the secondary Codex rate-limit window used (0-100), when available.
     */
    weekly_percent_used?: number | null;
    /**
     * Display label for the secondary Codex rate-limit window.
     */
    weekly_reset_text?: string | null;
};

