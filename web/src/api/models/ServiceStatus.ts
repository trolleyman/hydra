/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
/**
 * Live status of one supervised service
 */
export type ServiceStatus = {
    name: string;
    command: string;
    host: boolean;
    /**
     * up = running; restarting = backing off after an unexpected exit; failed = gave up after exhausting restarts; down = intentionally stopped; paused = not running because the project has no active agents (starts when one is spawned)
     */
    state: ServiceStatus.state;
    /**
     * Restarts performed so far
     */
    restarts: number;
    max_restarts: number;
    /**
     * Process id while running, else 0
     */
    pid?: number;
    /**
     * Human-readable detail for non-running states (exit reason / last output)
     */
    message?: string;
};
export namespace ServiceStatus {
    /**
     * up = running; restarting = backing off after an unexpected exit; failed = gave up after exhausting restarts; down = intentionally stopped; paused = not running because the project has no active agents (starts when one is spawned)
     */
    export enum state {
        UP = 'up',
        RESTARTING = 'restarting',
        FAILED = 'failed',
        DOWN = 'down',
        PAUSED = 'paused',
    }
}

