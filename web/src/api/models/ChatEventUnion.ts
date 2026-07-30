/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { AssistantDeltaEvent } from './AssistantDeltaEvent';
import type { AssistantMessageEvent } from './AssistantMessageEvent';
import type { CommitCreatedEvent } from './CommitCreatedEvent';
import type { ContentStreamCompletedEvent } from './ContentStreamCompletedEvent';
import type { ContentStreamStartedEvent } from './ContentStreamStartedEvent';
import type { ContextMessageEvent } from './ContextMessageEvent';
import type { ConversationStartedEvent } from './ConversationStartedEvent';
import type { HeadChangedEvent } from './HeadChangedEvent';
import type { HeadObservedEvent } from './HeadObservedEvent';
import type { InteractionRequestedEvent } from './InteractionRequestedEvent';
import type { InteractionResolvedEvent } from './InteractionResolvedEvent';
import type { MessagesRetractedEvent } from './MessagesRetractedEvent';
import type { ModelChangedEvent } from './ModelChangedEvent';
import type { NoticeEvent } from './NoticeEvent';
import type { PlanDeltaEvent } from './PlanDeltaEvent';
import type { PlanUpdatedEvent } from './PlanUpdatedEvent';
import type { QueuedMessageEvent } from './QueuedMessageEvent';
import type { QueueMessageRemovedEvent } from './QueueMessageRemovedEvent';
import type { ReasoningCompletedEvent } from './ReasoningCompletedEvent';
import type { ReasoningDeltaEvent } from './ReasoningDeltaEvent';
import type { ReasoningDurationEvent } from './ReasoningDurationEvent';
import type { SessionResumedEvent } from './SessionResumedEvent';
import type { SubagentCompletedEvent } from './SubagentCompletedEvent';
import type { SubagentStartedEvent } from './SubagentStartedEvent';
import type { SubagentUpdatedEvent } from './SubagentUpdatedEvent';
import type { ToolCompletedEvent } from './ToolCompletedEvent';
import type { ToolDeltaEvent } from './ToolDeltaEvent';
import type { ToolStartedEvent } from './ToolStartedEvent';
import type { TurnCompletedEvent } from './TurnCompletedEvent';
import type { TurnErrorEvent } from './TurnErrorEvent';
import type { TurnFailedEvent } from './TurnFailedEvent';
import type { TurnInterruptedEvent } from './TurnInterruptedEvent';
import type { TurnStartedEvent } from './TurnStartedEvent';
import type { UsageUpdatedEvent } from './UsageUpdatedEvent';
import type { UserMessageEchoedEvent } from './UserMessageEchoedEvent';
import type { UserMessageEvent } from './UserMessageEvent';
/**
 * One normalized event, narrowed by its type to the payload it carries.
 */
export type ChatEventUnion = (ConversationStartedEvent | UserMessageEvent | UserMessageEchoedEvent | ContextMessageEvent | AssistantMessageEvent | AssistantDeltaEvent | ReasoningCompletedEvent | ReasoningDeltaEvent | ReasoningDurationEvent | ContentStreamStartedEvent | ContentStreamCompletedEvent | ToolStartedEvent | ToolCompletedEvent | ToolDeltaEvent | PlanUpdatedEvent | PlanDeltaEvent | SubagentStartedEvent | SubagentUpdatedEvent | SubagentCompletedEvent | TurnStartedEvent | TurnCompletedEvent | TurnFailedEvent | TurnInterruptedEvent | TurnErrorEvent | UsageUpdatedEvent | MessagesRetractedEvent | NoticeEvent | SessionResumedEvent | InteractionRequestedEvent | InteractionResolvedEvent | CommitCreatedEvent | HeadChangedEvent | HeadObservedEvent | ModelChangedEvent | QueuedMessageEvent | QueueMessageRemovedEvent);

