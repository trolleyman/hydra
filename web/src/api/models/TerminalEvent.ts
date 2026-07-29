/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { HeadDiffRefreshEvent } from './HeadDiffRefreshEvent';
import type { HeadStatusEvent } from './HeadStatusEvent';
import type { TerminalDataEvent } from './TerminalDataEvent';
import type { TerminalSizeEvent } from './TerminalSizeEvent';
/**
 * One server-to-client control event on a terminal-mode socket.
 */
export type TerminalEvent = (HeadStatusEvent | TerminalDataEvent | HeadDiffRefreshEvent | TerminalSizeEvent);

