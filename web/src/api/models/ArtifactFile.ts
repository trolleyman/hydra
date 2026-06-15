/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
export type ArtifactFile = {
    /**
     * File name relative to the artifact set
     */
    name: string;
    change_type: ArtifactFile.change_type;
    /**
     * URL of the file for the left version (null if absent on the left)
     */
    left_url?: string | null;
    /**
     * URL of the file for the right version (null if absent on the right)
     */
    right_url?: string | null;
};
export namespace ArtifactFile {
    export enum change_type {
        ADDED = 'added',
        REMOVED = 'removed',
        MODIFIED = 'modified',
        UNCHANGED = 'unchanged',
    }
}

