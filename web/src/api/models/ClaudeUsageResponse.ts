/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
export type ClaudeUsageResponse = {
    /**
     * True when a usable usage snapshot was obtained.
     */
    available: boolean;
    /**
     * Why usage is unavailable (CLI missing, not a subscription account, parse failure, ...).
     */
    error?: string | null;
    /**
     * When the snapshot was probed.
     */
    captured_at?: string;
    /**
     * Detected plan, e.g. "Claude Max" or "Claude Pro".
     */
    account_tier?: string | null;
    /**
     * Percent of the current session ("4 hour") limit used (0-100).
     */
    session_percent_used?: number | null;
    /**
     * When the current session limit resets (derived from the relative "Resets in ..." text).
     */
    session_resets_at?: string | null;
    /**
     * Raw session reset text, e.g. "Resets in 2h 15m".
     */
    session_reset_text?: string | null;
    /**
     * Percent of the weekly (all-models) limit used (0-100).
     */
    weekly_percent_used?: number | null;
    /**
     * Raw weekly reset text, e.g. "Resets Jan 15, 3:30pm".
     */
    weekly_reset_text?: string | null;
};

