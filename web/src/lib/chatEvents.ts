import type {
  ChatAssistantMessagePayload,
  ChatCommitCreatedPayload,
  ChatContentStreamPayload,
  ChatContextMessagePayload,
  ChatConversationStartedPayload,
  ChatDeltaPayload,
  ChatEvent,
  ChatProviderContext,
  ChatHeadChangedPayload,
  ChatInteractionPayload,
  ChatItemDeltaPayload,
  ChatMessagesRetractedPayload,
  ChatModelChangedPayload,
  ChatNoticePayload,
  ChatPlanUpdatedPayload,
  ChatReasoningCompletedPayload,
  ChatReasoningDurationPayload,
  ChatSubagentPayload,
  ChatToolCompletedPayload,
  ChatToolStartedPayload,
  ChatTurnPayload,
  ChatUsageUpdatedPayload,
  ChatUserMessageEchoedPayload,
  ChatUserMessagePayload,
} from '../api'

// A normalized chat event, narrowed by its `type` to the payload that type
// carries. The envelope and every payload below are generated from
// api/openapi.yaml; this file is the thirty lines OpenAPI itself cannot express.
//
// A discriminator only works on a property within the SAME schema, so `payload`
// cannot declare a oneOf keyed on its sibling `type`. Modelling it as one union
// would mean repeating the envelope for all thirty types and turning ChatEvent
// into an opaque generated union wrapper - which the daemon's event store, which
// reads `.Seq`/`.Type` off every event, cannot field-access. So the schema names
// each payload and the discrimination is composed here instead.
//
// The union is deliberately CLOSED. A `type: string` member would overlap every
// literal and defeat narrowing, so an event type this build does not know simply
// matches no case: every consumer either switches with a default or guards with
// `if (ev.type !== 'x') return`, so a newer daemon's event is ignored rather
// than mishandled - which is the fallback behaviour we want anyway.
type Event<T extends string, P> = Omit<ChatEvent, 'type' | 'payload'> & { type: T; payload: P }

// A provider-derived event's payload is its own fields PLUS the shared context
// (who produced it, where it belongs). The schema keeps the two separate so the
// daemon can embed them - Go promotes an embedded struct's fields, so the wire
// stays flat - and here they intersect to the same shape.
type ProviderEventOf<T extends string, P> = Event<T, P & ChatProviderContext>

// The wire may omit an empty payload, but every payload's fields are optional,
// so defaulting it to {} here lets the cases below read fields without a guard
// on every access. This is the one place the daemon's schema guarantee is taken
// on trust: `type` arrives as an open string, so nothing but the schema
// correlates it with its payload.
export function asNormalizedChatEvent(ev: ChatEvent): NormalizedChatEvent {
  return { ...ev, payload: ev.payload ?? {} } as NormalizedChatEvent
}

export type NormalizedChatEvent =
  | ProviderEventOf<'conversation_started', ChatConversationStartedPayload>
  | ProviderEventOf<'user_message', ChatUserMessagePayload>
  | Event<'user_message_echoed', ChatUserMessageEchoedPayload>
  | ProviderEventOf<'context_message', ChatContextMessagePayload>
  | ProviderEventOf<'assistant_message', ChatAssistantMessagePayload>
  | ProviderEventOf<'assistant_delta', ChatDeltaPayload>
  | ProviderEventOf<'reasoning_completed', ChatReasoningCompletedPayload>
  | ProviderEventOf<'reasoning_delta', ChatDeltaPayload>
  | Event<'reasoning_duration', ChatReasoningDurationPayload>
  | ProviderEventOf<'content_stream_started', ChatContentStreamPayload>
  | ProviderEventOf<'content_stream_completed', ChatContentStreamPayload>
  | ProviderEventOf<'tool_started', ChatToolStartedPayload>
  | ProviderEventOf<'tool_completed', ChatToolCompletedPayload>
  | ProviderEventOf<'tool_delta', ChatItemDeltaPayload>
  | ProviderEventOf<'plan_updated', ChatPlanUpdatedPayload>
  | ProviderEventOf<'plan_delta', ChatItemDeltaPayload>
  | ProviderEventOf<'subagent_started', ChatSubagentPayload>
  | ProviderEventOf<'subagent_updated', ChatSubagentPayload>
  | ProviderEventOf<'subagent_completed', ChatSubagentPayload>
  | ProviderEventOf<'turn_started', ChatTurnPayload>
  | ProviderEventOf<'turn_completed', ChatTurnPayload>
  | ProviderEventOf<'turn_failed', ChatTurnPayload>
  | ProviderEventOf<'turn_interrupted', ChatTurnPayload>
  | ProviderEventOf<'turn_error', ChatTurnPayload>
  | Event<'usage_updated', ChatUsageUpdatedPayload>
  | ProviderEventOf<'messages_retracted', ChatMessagesRetractedPayload>
  | ProviderEventOf<'notice', ChatNoticePayload>
  | ProviderEventOf<'interaction_requested', ChatInteractionPayload>
  | ProviderEventOf<'interaction_resolved', ChatInteractionPayload>
  | Event<'commit_created', ChatCommitCreatedPayload>
  | Event<'head_changed', ChatHeadChangedPayload>
  | Event<'head_observed', ChatHeadChangedPayload>
  | Event<'model_changed', ChatModelChangedPayload>

// Fields that several payload types share, read off an event whose type has not
// been narrowed. `in` is the narrowing: asking for one of these is asking "does
// this event happen to carry it", so the answer is a value or nothing rather
// than an index into a union.
export function eventMessageID(ev: NormalizedChatEvent): string {
  return 'message_id' in ev.payload ? ev.payload.message_id ?? '' : ''
}

export function eventItemID(ev: NormalizedChatEvent): string {
  return 'id' in ev.payload ? ev.payload.id ?? '' : ''
}

export function isSidechainEvent(ev: NormalizedChatEvent): boolean {
  return 'sidechain' in ev.payload && ev.payload.sidechain === true
}
