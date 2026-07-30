/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
export type UpdateReviewCommentBody = {
    body: string;
    /**
     * Replaces the draft's attachments wholesale, like body. Omitted leaves them untouched, so a caller that predates attachments cannot silently drop them.
     *
     */
    attachments?: Array<string>;
};

