/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { ReviewImageAnchor } from './ReviewImageAnchor';
/**
 * One durable, numbered review comment. The number is the handle everything else uses ("fix #3") - one token for a model, speakable by a person, and never reused.
 *
 */
export type ReviewComment = {
    /**
     * Per-head sequence number, rendered "#4". Retired numbers are never reissued.
     */
    number: number;
    /**
     * A draft is yours alone - synced across reloads and devices, invisible to every agent tool.
     */
    status: ReviewComment.status;
    /**
     * "user" | "reviewer" | "agent".
     */
    author: string;
    body: string;
    /**
     * The comment this replies to, which is how a thread forms without a separate thread object.
     */
    reply_to?: number;
    path?: string;
    line?: number;
    /**
     * The line is on the OLD side of the diff (removed lines).
     */
    old_side?: boolean;
    /**
     * Head commit the comment was written against.
     */
    commit?: string;
    /**
     * The comparison it was written on, e.g. "main -> abc1234".
     */
    diff?: string;
    /**
     * Fenced ```diff block of the surrounding lines, frozen at write time.
     */
    context?: string;
    /**
     * Hash of the anchoring hunk when written, so staleness is detectable later.
     */
    hunk_hash?: string;
    created_at: string;
    published_at?: string;
    /**
     * Dealt with. A state change, not an edit - the body is untouched and still readable.
     */
    resolved?: boolean;
    resolved_at?: string;
    /**
     * The user has seen it. Set only by an explicit mark-read; nothing becomes read by the passage of time.
     */
    read?: boolean;
    /**
     * Absolute paths of files attached to the comment, under the project's uploads directory in Hydra's state root. A separate field rather than paths pasted into the body because a draft's body is edited in a textarea (raw paths would be in it) and because copy-as-markdown and the forge-publish path must not leak them. The path resolves identically on the host and inside every agent sandbox, so the agent reads the file directly; the browser renders it through the uploads blob endpoint.
     *
     */
    attachments?: Array<string>;
    image?: ReviewImageAnchor;
};
export namespace ReviewComment {
    /**
     * A draft is yours alone - synced across reloads and devices, invisible to every agent tool.
     */
    export enum status {
        DRAFT = 'draft',
        PUBLISHED = 'published',
    }
}

