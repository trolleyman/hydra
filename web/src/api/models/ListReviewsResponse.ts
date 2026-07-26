/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { ReviewRef } from './ReviewRef';
/**
 * The open PRs/MRs available to adopt, plus the forge auth state so the picker can show a "run gh/glab auth login" hint (docs/pr-adoption.md).
 */
export type ListReviewsResponse = {
    /**
     * True when a forge provider could be resolved for the project.
     */
    configured: boolean;
    /**
     * Whether the forge CLI is authenticated.
     */
    authenticated: boolean;
    /**
     * Resolved provider ("github" | "gitlab" | "").
     */
    provider?: string;
    /**
     * Live auth status line, when not authenticated / configured.
     */
    auth_status?: string;
    /**
     * Human-readable reason the list is empty/unavailable (not configured, CLI missing, list failed).
     */
    error?: string;
    reviews: Array<ReviewRef>;
};

