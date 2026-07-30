/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { ReviewComment } from './ReviewComment';
/**
 * A head's Hydra-native review comments (docs/review-agent.md).
 */
export type ReviewCommentsResponse = {
    comments: Array<ReviewComment>;
    /**
     * On a publish, the one line the agent was told. Absent otherwise.
     */
    notified?: string;
    /**
     * Who "you" is on this machine, from git's user.name. Hydra has no accounts and hosts no pictures, so a comment you wrote is drawn as a monogram of this rather than an avatar. Empty when git has no user.name configured.
     *
     */
    you?: string;
};

