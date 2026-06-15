/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
export type RepositoryFileResponse = {
    /**
     * Repo-relative path of the file
     */
    path: string;
    /**
     * The git ref the file was read from
     */
    ref: string;
    /**
     * File size in bytes
     */
    size: number;
    /**
     * True when the file looks binary; content is then omitted
     */
    binary: boolean;
    /**
     * True when content was truncated because the file is large
     */
    truncated: boolean;
    /**
     * UTF-8 file content (omitted for binary files)
     */
    content?: string | null;
};

