/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
export type FolderPickerOpenResponse = {
    /**
     * The picked folder's absolute path; absent when cancelled
     */
    path?: string;
    /**
     * True when the dialog was dismissed. A non-zero exit is the normal cancel signal for these tools and can't be reliably told apart from a genuine failure, so both are reported as a cancel.
     */
    cancelled?: boolean;
};

