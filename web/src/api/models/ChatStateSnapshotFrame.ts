/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { ChatProjection } from './ChatProjection';
/**
 * The head's current state, sent first on attach. Taken with the history watermark under one lock, so a plan or sub-agent cannot change between snapshotting and subscribing.
 */
export type ChatStateSnapshotFrame = {
    type: 'state_snapshot';
    state: ChatProjection;
};

