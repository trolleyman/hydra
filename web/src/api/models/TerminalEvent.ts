/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { TerminalDataEvent } from './TerminalDataEvent';
import type { TerminalDiffRefreshEvent } from './TerminalDiffRefreshEvent';
import type { TerminalSizeEvent } from './TerminalSizeEvent';
import type { TerminalStatusEvent } from './TerminalStatusEvent';
/**
 * One server-to-client control event on a terminal-mode socket.
 */
export type TerminalEvent = (TerminalStatusEvent | TerminalDataEvent | TerminalDiffRefreshEvent | TerminalSizeEvent);

