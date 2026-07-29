/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
/**
 * The tail of a background task's output file, or why it could not be read.
 */
export type ChatTaskOutputFrame = {
    type: 'task_output';
    file: string;
    content?: string;
    error?: string;
};

