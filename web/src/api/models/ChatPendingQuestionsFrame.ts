/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { ChatPendingAsk } from './ChatPendingAsk';
/**
 * Which question cards can still be answered. A question's request id is durable and replays forever, but the request behind it dies with the turn that raised it, so the client cannot tell a live card from a dead one on its own. An empty list is a definite none; the frame being omitted entirely means the daemon cannot say.
 */
export type ChatPendingQuestionsFrame = {
    type: 'pending_questions';
    requests: Array<ChatPendingAsk>;
};

