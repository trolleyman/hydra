/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { ServerUpdateDoneFrame } from './ServerUpdateDoneFrame';
import type { ServerUpdateLogFrame } from './ServerUpdateLogFrame';
import type { ServerUpdatePhaseFrame } from './ServerUpdatePhaseFrame';
/**
 * One frame, narrowed by its kind to the field that kind carries. What the browser reads.
 */
export type ServerUpdateFrame = (ServerUpdatePhaseFrame | ServerUpdateLogFrame | ServerUpdateDoneFrame);

