/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
export type ErrorResponse = {
    /**
     * Machine-readable error type (e.g. internal_error, not_found, unauthorized)
     */
    error: string;
    /**
     * HTTP status code
     */
    code: number;
    /**
     * Human-readable error description
     */
    details: string;
};

