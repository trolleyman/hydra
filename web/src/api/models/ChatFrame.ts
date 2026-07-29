/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { ChatDiffRefreshFrame } from './ChatDiffRefreshFrame';
import type { ChatErrorFrame } from './ChatErrorFrame';
import type { ChatEventFrame } from './ChatEventFrame';
import type { ChatHistoryFrame } from './ChatHistoryFrame';
import type { ChatPendingQuestionsFrame } from './ChatPendingQuestionsFrame';
import type { ChatQuestionExpiredFrame } from './ChatQuestionExpiredFrame';
import type { ChatQueueFrame } from './ChatQueueFrame';
import type { ChatReplayDoneFrame } from './ChatReplayDoneFrame';
import type { ChatShellOutputFrame } from './ChatShellOutputFrame';
import type { ChatStateSnapshotFrame } from './ChatStateSnapshotFrame';
import type { ChatStatusFrame } from './ChatStatusFrame';
import type { ChatSubagentEventsFrame } from './ChatSubagentEventsFrame';
import type { ChatTaskOutputFrame } from './ChatTaskOutputFrame';
/**
 * One server-to-client frame on a chat-mode socket. Each member declares its own single value for `type`, so a client narrows on it directly.
 */
export type ChatFrame = (ChatStatusFrame | ChatDiffRefreshFrame | ChatStateSnapshotFrame | ChatHistoryFrame | ChatEventFrame | ChatSubagentEventsFrame | ChatReplayDoneFrame | ChatQueueFrame | ChatPendingQuestionsFrame | ChatQuestionExpiredFrame | ChatShellOutputFrame | ChatTaskOutputFrame | ChatErrorFrame);

