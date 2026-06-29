/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
export type ProjectInfo = {
    /**
     * Unique project identifier (derived from folder name)
     */
    id: string;
    /**
     * Absolute filesystem path to the project root
     */
    path: string;
    /**
     * Human-readable project name (last path component)
     */
    name: string;
    /**
     * Number of this project's agents with unread changes. Drives the cross-project "updates waiting" indicator.
     */
    unread_count?: number;
    /**
     * Number of this project's agents currently blocked on the user (status `needs_input`). Drives the red "needs your input" indicator, which is shown whenever this is greater than zero.
     */
    needs_input_count?: number;
};

