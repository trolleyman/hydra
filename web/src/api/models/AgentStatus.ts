/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
/**
 * The computed status of the agent (derived from container, agent, and head status). `needs_input` is the explicit "the agent is blocked on you" state (an AskUserQuestion elicitation, an ExitPlanMode plan approval, or a permission prompt) and is surfaced prominently; `waiting` is the softer "gone quiet" idle nudge.
 */
export enum AgentStatus {
    PENDING = 'pending',
    BUILDING = 'building',
    STARTING = 'starting',
    RUNNING = 'running',
    NEEDS_INPUT = 'needs_input',
    WAITING = 'waiting',
    FINISHED = 'finished',
    STOPPED = 'stopped',
    KILLING = 'killing',
    MERGING = 'merging',
}
