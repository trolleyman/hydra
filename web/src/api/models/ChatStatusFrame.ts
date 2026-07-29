/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { AgentStatus } from './AgentStatus';
/**
 * The head's computed status changed. Shares its shape with the terminal socket.
 */
export type ChatStatusFrame = {
    type: 'status';
    status: AgentStatus;
};

