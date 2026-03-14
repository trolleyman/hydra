/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
export type ErrorResponse = {
    /**
     * Machine-readable error type (e.g. internal_error, not_found, unauthorized, docker_connect)
     */
    error: ErrorResponse.error;
    /**
     * HTTP status code
     */
    code: number;
    /**
     * Human-readable error description
     */
    details: string;
};
export namespace ErrorResponse {
    /**
     * Machine-readable error type (e.g. internal_error, not_found, unauthorized, docker_connect)
     */
    export enum error {
        NOT_FOUND = 'not_found',
        UNAUTHORIZED = 'unauthorized',
        INTERNAL_ERROR = 'internal_error',
        DOCKER_CONNECT = 'docker_connect',
        PATH_NOT_FOUND = 'path_not_found',
        NOT_A_GIT_REPO = 'not_a_git_repo',
        BAD_REQUEST = 'bad_request',
        CONFLICT = 'conflict',
    }
}

