/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { ChatPlanEntry } from './ChatPlanEntry';
/**
 * A plan checkpoint. Also folded into the projection.
 */
export type ChatPlanUpdatedPayload = {
    /**
     * Which provider produced it. Claude's Task cards already carry the timeline, so only Codex renders a visible Update Plan card.
     */
    provider?: string;
    plan?: Array<ChatPlanEntry>;
};

