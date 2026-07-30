/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { ReviewImageAnchor } from './ReviewImageAnchor';
export type NewReviewCommentBody = {
    body: string;
    path?: string;
    line?: number;
    old_side?: boolean;
    commit?: string;
    diff?: string;
    context?: string;
    hunk_hash?: string;
    reply_to?: number;
    /**
     * Absolute paths under the project's .hydra/local/uploads, from the upload endpoint. Anything outside that directory is rejected.
     *
     */
    attachments?: Array<string>;
    image?: ReviewImageAnchor;
    /**
     * Publish immediately instead of storing a draft (the "Comment to agent" one-shot path).
     */
    publish?: boolean;
};

