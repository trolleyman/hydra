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
};

