/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
export type RepositoryTreeResponse = {
    /**
     * The git ref the tree was read from (e.g. HEAD)
     */
    ref: string;
    /**
     * Suggested file to open first (README.md when present), or null
     */
    default_path?: string | null;
    /**
     * Repo-relative paths of every file tracked at this ref
     */
    files: Array<string>;
};

