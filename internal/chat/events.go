package chat

import (
	"encoding/json"

	"braces.dev/errtrace"
	"github.com/trolleyman/hydra/internal/api"
)

// One type per normalized event, so an event's type and its payload cannot
// disagree: the payload names its own type, and Append derives it.
//
// Each is the generated payload schema (api/openapi.yaml) plus, for the
// provider-derived ones, the generated ChatProviderContext. Go embeds rather
// than repeats: encoding/json promotes an embedded struct's fields, so the wire
// stays exactly as flat as the schema describes, while a construction site
// fills the context once instead of copying eight fields. The methods live here
// rather than in internal/api because Go only allows them in a type's own
// package, and the generated file is not a place to hand-write.
//
// TypeScript composes the same two halves by intersection - see
// web/src/lib/chatEvents.ts.
type Payload interface{ EventType() string }

// ProviderContext is who produced an event and where it belongs. Embedded by
// every provider-derived payload below.
//
// A defined type rather than an alias so it can carry SetSidechain: an alias
// would put the methods in internal/api, where they cannot be written. Embedding
// a defined struct promotes its fields for encoding/json exactly the same way.
type ProviderContext api.ChatProviderContext

// SetSidechain marks an event as one of sub-agent agentID's own steps. Codex
// applies this to every event in a sub-agent thread, deltas included, so it is
// promoted onto each payload rather than set field by field at each site.
func (c *ProviderContext) SetSidechain(agentID, parentItemID string) {
	c.Sidechain = true
	c.AgentId = agentID
	if parentItemID != "" {
		c.ParentItemId = parentItemID
	}
}

// sidechainSetter is any event that can be marked as a sub-agent's step - i.e.
// anything embedding ProviderContext.
type sidechainSetter interface {
	SetSidechain(agentID, parentItemID string)
}

type ConversationStarted struct {
	api.ChatConversationStartedPayload
}

type UserMessage struct {
	ProviderContext
	api.ChatUserMessagePayload
}

// UserMessageEchoed reconciles a provider's echo of a message Hydra already
// recorded, rather than rendering it twice.
type UserMessageEchoed struct {
	api.ChatUserMessageEchoedPayload
}

type ContextMessage struct {
	ProviderContext
	api.ChatContextMessagePayload
}

type AssistantMessage struct {
	ProviderContext
	api.ChatAssistantMessagePayload
}

type AssistantDelta struct {
	ProviderContext
	api.ChatDeltaPayload
}

type ReasoningCompleted struct {
	ProviderContext
	api.ChatReasoningCompletedPayload
}

type ReasoningDelta struct {
	ProviderContext
	api.ChatDeltaPayload
}

// ReasoningDuration is measured by the daemon: no provider reports it, and a
// model may emit an empty reasoning block that only this makes visible.
type ReasoningDuration struct {
	api.ChatReasoningDurationPayload
}

type ContentStreamStarted struct {
	ProviderContext
	api.ChatContentStreamPayload
}

type ContentStreamCompleted struct {
	ProviderContext
	api.ChatContentStreamPayload
}

type ToolStarted struct {
	ProviderContext
	api.ChatToolStartedPayload
}

type ToolCompleted struct {
	ProviderContext
	api.ChatToolCompletedPayload
}

type ToolDelta struct {
	ProviderContext
	api.ChatItemDeltaPayload
}

type PlanUpdated struct {
	ProviderContext
	api.ChatPlanUpdatedPayload
}

type PlanDelta struct {
	ProviderContext
	api.ChatItemDeltaPayload
}

type SubagentStarted struct {
	ProviderContext
	api.ChatSubagentPayload
}

type SubagentUpdated struct {
	ProviderContext
	api.ChatSubagentPayload
}

type SubagentCompleted struct {
	ProviderContext
	api.ChatSubagentPayload
}

type TurnStarted struct {
	ProviderContext
	api.ChatTurnPayload
}

type TurnCompleted struct {
	ProviderContext
	api.ChatTurnPayload
}

type TurnFailed struct {
	ProviderContext
	api.ChatTurnPayload
}

type TurnInterrupted struct {
	ProviderContext
	api.ChatTurnPayload
}

type TurnError struct {
	ProviderContext
	api.ChatTurnPayload
}

// UsageUpdated carries no ProviderContext: its own `usage` is the event, and an
// embedded one would collide on that json tag. It is stream-only - the live
// token counter reads it and nothing renders a card from it.
type UsageUpdated struct {
	api.ChatUsageUpdatedPayload
}

type MessagesRetracted struct {
	ProviderContext
	api.ChatMessagesRetractedPayload
}

type Notice struct {
	ProviderContext
	api.ChatNoticePayload
}

// SessionResumed is Hydra's own: the provider cannot report its own replacement,
// and `--continue` reuses the session id so the new process's
// conversation_started dedups against the old one. Appended by the resume hook
// (internal/cli/runtime.go) at the exact point in the log where the old process
// stopped, which is what lets the client draw the break and re-anchor anything
// that outlived a turn - the Bash tool's shell above all.
type SessionResumed struct {
	api.ChatSessionResumedPayload
}

type InteractionRequested struct {
	ProviderContext
	api.ChatInteractionPayload
}

type InteractionResolved struct {
	ProviderContext
	api.ChatInteractionPayload
}

// CommitCreated and the two head events are Hydra's own: the reconciler
// observes git, so they carry no provider context.
type CommitCreated struct {
	api.ChatCommitCreatedPayload
}

type HeadChanged struct {
	api.ChatHeadChangedPayload
}

type HeadObserved struct {
	api.ChatHeadChangedPayload
}

type ModelChanged struct {
	api.ChatModelChangedPayload
}

// QueuedMessage and QueueMessageRemoved move a message in and out of the queue
// projection. They are Hydra's own bookkeeping - the provider has not seen the
// message yet - so they carry no provider context.
type QueuedMessage struct {
	api.ChatQueuedMessagePayload
}

type QueueMessageRemoved struct {
	api.ChatQueueMessageRemovedPayload
}

func (ConversationStarted) EventType() string    { return "conversation_started" }
func (UserMessage) EventType() string            { return "user_message" }
func (UserMessageEchoed) EventType() string      { return "user_message_echoed" }
func (ContextMessage) EventType() string         { return "context_message" }
func (AssistantMessage) EventType() string       { return "assistant_message" }
func (AssistantDelta) EventType() string         { return "assistant_delta" }
func (ReasoningCompleted) EventType() string     { return "reasoning_completed" }
func (ReasoningDelta) EventType() string         { return "reasoning_delta" }
func (ReasoningDuration) EventType() string      { return "reasoning_duration" }
func (ContentStreamStarted) EventType() string   { return "content_stream_started" }
func (ContentStreamCompleted) EventType() string { return "content_stream_completed" }
func (ToolStarted) EventType() string            { return "tool_started" }
func (ToolCompleted) EventType() string          { return "tool_completed" }
func (ToolDelta) EventType() string              { return "tool_delta" }
func (PlanUpdated) EventType() string            { return "plan_updated" }
func (PlanDelta) EventType() string              { return "plan_delta" }
func (SubagentStarted) EventType() string        { return "subagent_started" }
func (SubagentUpdated) EventType() string        { return "subagent_updated" }
func (SubagentCompleted) EventType() string      { return "subagent_completed" }
func (TurnStarted) EventType() string            { return "turn_started" }
func (TurnCompleted) EventType() string          { return "turn_completed" }
func (TurnFailed) EventType() string             { return "turn_failed" }
func (TurnInterrupted) EventType() string        { return "turn_interrupted" }
func (TurnError) EventType() string              { return "turn_error" }
func (UsageUpdated) EventType() string           { return "usage_updated" }
func (MessagesRetracted) EventType() string      { return "messages_retracted" }
func (Notice) EventType() string                 { return "notice" }
func (SessionResumed) EventType() string         { return "session_resumed" }
func (InteractionRequested) EventType() string   { return "interaction_requested" }
func (InteractionResolved) EventType() string    { return "interaction_resolved" }
func (CommitCreated) EventType() string          { return "commit_created" }
func (HeadChanged) EventType() string            { return "head_changed" }
func (HeadObserved) EventType() string           { return "head_observed" }
func (ModelChanged) EventType() string           { return "model_changed" }
func (QueuedMessage) EventType() string          { return "queued_message" }
func (QueueMessageRemoved) EventType() string    { return "queue_message_removed" }

// SetOutput fills in a tool's result. Codex settles some of its collaboration
// tools with a summary the item itself does not carry, so the spec is built and
// then completed rather than assembled in one literal.
func (t *ToolStarted) SetOutput(output string)   { t.Output, _ = json.Marshal(output) }
func (t *ToolCompleted) SetOutput(output string) { t.Output, _ = json.Marshal(output) }

// outputSetter is a tool event whose result can be filled in after the fact.
type outputSetter interface{ SetOutput(string) }

// rawPayload pairs an arbitrary payload with an explicit type. Producers all
// use the typed events above; this exists for the store's own tests, which
// exercise the projection reducer and do not care what a payload's fields are.
type rawPayload struct {
	eventType string
	raw       any
}

func (r rawPayload) EventType() string            { return r.eventType }
func (r rawPayload) MarshalJSON() ([]byte, error) { return errtrace.Wrap2(json.Marshal(r.raw)) }
