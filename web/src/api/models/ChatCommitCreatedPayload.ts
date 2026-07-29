/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { ChatMergedCommit } from './ChatMergedCommit';
/**
 * A commit the reconciler observed. Sequenced in the same log as the tool output that produced it, so the chip cannot render before its cause.
 */
export type ChatCommitCreatedPayload = {
    sha?: string;
    short_sha?: string;
    subject?: string;
    author_name?: string;
    author_email?: string;
    timestamp?: string;
    head?: string;
    /**
     * The tool call that produced it, when one is known.
     */
    causal_item_id?: string;
    is_merge?: boolean;
    merged_count?: number;
    merged_commits?: Array<ChatMergedCommit>;
};

