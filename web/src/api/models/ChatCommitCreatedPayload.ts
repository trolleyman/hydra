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
    /**
     * Number of lines added by the commit relative to its first parent
     */
    additions?: number;
    /**
     * Number of lines removed by the commit relative to its first parent
     */
    deletions?: number;
    head?: string;
    /**
     * The tool call that produced it, when one is known.
     */
    causal_item_id?: string;
    is_merge?: boolean;
    merged_count?: number;
    /**
     * The ref this merge brought in, when the reconciler knows it rather than having to read it out of the commit subject. Set when the head absorbed its base by FAST-FORWARD (update-from-base with nothing of its own to merge): the branch then sits on the base's own tip, whose subject names whatever that commit merged - another head - so the chip must be labelled from the ref that was pulled in, not from it.
     */
    merged_ref?: string;
    merged_commits?: Array<ChatMergedCommit>;
};

