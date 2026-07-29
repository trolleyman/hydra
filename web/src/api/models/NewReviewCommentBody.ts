/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
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
     * Publish immediately instead of storing a draft (the "Comment to agent" one-shot path).
     */
    publish?: boolean;
};

