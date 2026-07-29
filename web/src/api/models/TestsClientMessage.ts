/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
/**
 * Client to server. Only `refresh` is supported - re-run one runner.
 */
export type TestsClientMessage = {
    type: TestsClientMessage.type;
    name: string;
};
export namespace TestsClientMessage {
    export enum type {
        REFRESH = 'refresh',
    }
}

