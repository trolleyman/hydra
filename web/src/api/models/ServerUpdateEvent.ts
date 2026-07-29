/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { ServerUpdatePhase } from './ServerUpdatePhase';
/**
 * One frame of an update's progress, flat: the daemon constructs and fans these out internally, so it needs one struct rather than the union below. Both describe the same wire bytes.
 */
export type ServerUpdateEvent = {
    kind: ServerUpdateEvent.kind;
    phase?: ServerUpdatePhase;
    /**
     * One line of build output.
     */
    line?: string;
    /**
     * Set on a failed `done` frame; empty means success.
     */
    error?: string;
};
export namespace ServerUpdateEvent {
    export enum kind {
        PHASE = 'phase',
        LOG = 'log',
        DONE = 'done',
    }
}

