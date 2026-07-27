/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
export type ReorderProjectsRequest = {
    /**
     * Project IDs in the order they should be listed. Projects the caller omitted (e.g. added by another window since its list was fetched) keep their relative order after these; unknown IDs are ignored.
     */
    project_ids: Array<string>;
};

