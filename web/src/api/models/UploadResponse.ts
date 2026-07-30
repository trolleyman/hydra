/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
export type UploadResponse = {
    /**
     * Absolute HOST path of the stored file. The same path is valid inside every agent sandbox (the host filesystem is bind-mounted read-only at the same locations), which is what lets a prompt reference an upload by path for any agent type.
     */
    path: string;
    /**
     * The upload's bare on-disk name, for use with the blob route
     */
    filename: string;
};

