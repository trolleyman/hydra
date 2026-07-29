import type {
  ChatAssistantMessagePayload,
  ChatCommitCreatedPayload,
  ChatContentStreamPayload,
  ChatContextMessagePayload,
  ChatConversationStartedPayload,
  ChatDeltaPayload,
  ChatEvent,
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

// The wire may omit an empty payload, but every payload's fields are optional,
// so defaulting it to {} here lets the cases below read fields without a guard
// on every access. This is the one place the daemon's schema guarantee is taken
// on trust: `type` arrives as an open string, so nothing but the schema
// correlates it with its payload.
export function asNormalizedChatEvent(ev: ChatEvent): NormalizedChatEvent {
  return { ...ev, payload: ev.payload ?? {} } as NormalizedChatEvent
}

export type NormalizedChatEvent =
  | Event<'conversation_started', ChatConversationStartedPayload>
  | Event<'user_message', ChatUserMessagePayload>
  | Event<'user_message_echoed', ChatUserMessagePayload>
  | Event<'context_message', ChatContextMessagePayload>
  | Event<'assistant_message', ChatAssistantMessagePayload>
  | Event<'assistant_delta', ChatDeltaPayload>
  | Event<'reasoning_completed', ChatReasoningCompletedPayload>
  | Event<'reasoning_delta', ChatDeltaPayload>
  | Event<'reasoning_duration', ChatReasoningDurationPayload>
  | Event<'content_stream_started', ChatContentStreamPayload>
  | Event<'content_stream_completed', ChatContentStreamPayload>
  | Event<'tool_started', ChatToolStartedPayload>
  | Event<'tool_completed', ChatToolCompletedPayload>
  | Event<'tool_delta', ChatItemDeltaPayload>
  | Event<'plan_updated', ChatPlanUpdatedPayload>
  | Event<'plan_delta', ChatItemDeltaPayload>
  | Event<'subagent_started', ChatSubagentPayload>
  | Event<'subagent_updated', ChatSubagentPayload>
  | Event<'subagent_completed', ChatSubagentPayload>
  | Event<'turn_started', ChatTurnPayload>
  | Event<'turn_completed', ChatTurnPayload>
  | Event<'turn_failed', ChatTurnPayload>
  | Event<'turn_interrupted', ChatTurnPayload>
  | Event<'turn_error', ChatTurnPayload>
  | Event<'usage_updated', ChatUsageUpdatedPayload>
  | Event<'messages_retracted', ChatMessagesRetractedPayload>
  | Event<'notice', ChatNoticePayload>
  | Event<'interaction_requested', ChatInteractionPayload>
  | Event<'interaction_resolved', ChatInteractionPayload>
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
