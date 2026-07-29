import type { ChatEvent, ChatEventUnion } from '../api'

// A normalized chat event, narrowed by its `type` to the payload that type
// carries. Both the union and every member are generated from api/openapi.yaml,
// so which payload belongs to which type is stated once, in the schema, rather
// than asserted separately here and in the daemon.
//
// The socket's frames carry the OPEN ChatEvent (the envelope with a free-form
// payload), because the daemon's event store reads seq/type off every event and
// appends it to a log - which needs a concrete struct, and a generated oneOf is
// an opaque wrapper it cannot field-access. Both schemas describe the same wire
// bytes; asNormalizedChatEvent is the single point where one becomes the other.
export type NormalizedChatEvent = ChatEventUnion

// The wire may omit an empty payload, but every payload's fields are optional,
// so defaulting it to {} lets a case read fields without a guard on every
// access. This is the one place the schema is taken on trust: `type` arrives as
// an open string, so nothing else correlates it with its payload.
export function asNormalizedChatEvent(ev: ChatEvent): NormalizedChatEvent {
  return { ...ev, payload: ev.payload ?? {} } as NormalizedChatEvent
}

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
