/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
/**
 * The computed status of the agent (derived from container, agent, and head status)
 */
export enum AgentStatus {
    PENDING = 'pending',
    BUILDING = 'building',
    STARTING = 'starting',
    RUNNING = 'running',
    WAITING = 'waiting',
    STOPPED = 'stopped',
    KILLING = 'killing',
    MERGING = 'merging',
}
