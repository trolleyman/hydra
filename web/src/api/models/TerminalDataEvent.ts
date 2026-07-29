/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
/**
 * A chunk of PTY output, when it is relayed as text rather than binary.
 */
export type TerminalDataEvent = {
    type: 'data';
    /**
     * Base64 encoded binary data or plain string
     */
    data: string;
};

