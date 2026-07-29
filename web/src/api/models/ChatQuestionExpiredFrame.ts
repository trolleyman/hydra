/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
/**
 * An answer was dropped because its request had already been retired. The card flips to expired rather than settling on an "Answered" that never was.
 */
export type ChatQuestionExpiredFrame = {
    type: 'question_expired';
    requestId: string;
};

