/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
/**
 * The PTY's current window size, sent on attach right before the scrollback replay so the client can size its terminal to match. The replayed bytes carry cursor moves and wrapping computed for this width; rendering them at a different width corrupts the history.
 */
export type TerminalSizeEvent = {
    type: 'size';
    cols: number;
    rows: number;
};

