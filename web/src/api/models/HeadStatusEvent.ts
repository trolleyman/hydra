/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { AgentStatus } from './AgentStatus';
/**
 * The head's computed status changed. Sent on both sockets, so it belongs to both unions rather than being modelled twice.
 */
export type HeadStatusEvent = {
    type: 'status';
    status: AgentStatus;
};

