/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
export type AddProjectRequest = {
    /**
     * Absolute filesystem path to the project root (must be a git repository)
     */
    path: string;
    /**
     * Whether to create the directory if it doesn't exist.
     */
    create_if_missing?: boolean;
    /**
     * Whether to initialize a git repository if it's not already one.
     */
    init_git?: boolean;
};

