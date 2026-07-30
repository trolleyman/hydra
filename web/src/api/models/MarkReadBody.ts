/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
export type MarkReadBody = {
    /**
     * Numbers to mark. Omitted or empty covers every comment on the head.
     */
    numbers?: Array<number>;
    /**
     * Mark them UNread instead - "I have seen this and want to come back to it", which is the only way a comment goes back to being new.
     */
    unread?: boolean;
};

