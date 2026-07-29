/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
/**
 * The update finished without restarting - which in practice means it failed, since a success re-execs instead of sending this.
 */
export type ServerUpdateDoneFrame = {
    kind: 'done';
    /**
     * Empty means success.
     */
    error?: string;
};

