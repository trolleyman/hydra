package chat

import (
	"encoding/json"
	"reflect"
	"testing"
	"time"

	"github.com/trolleyman/hydra/internal/api"
)

// Every event type Go can produce, one of each. Adding an event means adding it
// here, which is what makes the test below meaningful.
func allPayloads() []Payload {
	return []Payload{
		ConversationStarted{}, UserMessage{}, UserMessageEchoed{}, ContextMessage{},
		AssistantMessage{}, AssistantDelta{}, ReasoningCompleted{}, ReasoningDelta{},
		ReasoningDuration{}, ContentStreamStarted{}, ContentStreamCompleted{},
		ToolStarted{}, ToolCompleted{}, ToolDelta{}, PlanUpdated{}, PlanDelta{},
		SubagentStarted{}, SubagentUpdated{}, SubagentCompleted{},
		TurnStarted{}, TurnCompleted{}, TurnFailed{}, TurnInterrupted{}, TurnError{},
		UsageUpdated{}, MessagesRetracted{}, Notice{}, SessionResumed{}, ShellCwd{},
		InteractionRequested{},
		InteractionResolved{}, CommitCreated{}, HeadChanged{}, HeadObserved{},
		ModelChanged{}, QueuedMessage{}, QueueMessageRemoved{},
	}
}

// The schema's ChatEventUnion says which payload each event type carries, and
// the typed events in events.go say the same thing in Go. This checks they
// agree: an event marshalled the way the store writes it must resolve, through
// the generated union, to the member the schema maps its type to.
//
// Without this the mapping would be asserted twice - once in the schema for the
// browser, once in Go for the daemon - with nothing catching a divergence until
// a card rendered blank.
func TestEveryEventResolvesToItsSchemaMember(t *testing.T) {
	for _, payload := range allPayloads() {
		raw, err := json.Marshal(Event{
			Seq: 1, Type: payload.EventType(), Timestamp: time.Unix(0, 0).UTC(),
			Payload: mustMarshal(t, payload),
		})
		if err != nil {
			t.Fatalf("%s: marshal event: %v", payload.EventType(), err)
		}
		var union api.ChatEventUnion
		if err := json.Unmarshal(raw, &union); err != nil {
			t.Errorf("%s: not a ChatEventUnion: %v", payload.EventType(), err)
			continue
		}
		discriminator, err := union.Discriminator()
		if err != nil {
			t.Errorf("%s: no discriminator: %v", payload.EventType(), err)
			continue
		}
		if discriminator != payload.EventType() {
			t.Errorf("discriminator = %q, want %q", discriminator, payload.EventType())
			continue
		}
		// Resolving picks the schema member for this type; it fails when the
		// schema has no mapping for an event Go produces.
		if _, err := union.ValueByDiscriminator(); err != nil {
			t.Errorf("%s: schema has no member for this type: %v", payload.EventType(), err)
		}
	}
}

// The reverse direction: an event type the schema maps but Go cannot produce is
// a member nothing will ever send, which usually means a producer was removed
// and its schema entry left behind.
func TestEverySchemaMemberHasAGoEvent(t *testing.T) {
	produced := map[string]bool{}
	for _, payload := range allPayloads() {
		produced[payload.EventType()] = true
	}
	for _, eventType := range schemaEventTypes(t) {
		if !produced[eventType] {
			t.Errorf("schema maps %q but no Go event produces it", eventType)
		}
	}
}

// schemaEventTypes reads the discriminator mapping back out of the generated
// union, by asking it to resolve each type Go knows plus probing for any it
// does not. The generated ValueByDiscriminator is the only in-process view of
// the schema's mapping, so this reads it rather than re-parsing the YAML.
func schemaEventTypes(t *testing.T) []string {
	t.Helper()
	var types []string
	for _, payload := range allPayloads() {
		raw, _ := json.Marshal(map[string]any{
			"seq": 1, "type": payload.EventType(), "timestamp": "1970-01-01T00:00:00Z",
			"payload": map[string]any{},
		})
		var union api.ChatEventUnion
		if json.Unmarshal(raw, &union) != nil {
			continue
		}
		if _, err := union.ValueByDiscriminator(); err == nil {
			types = append(types, payload.EventType())
		}
	}
	return types
}

func mustMarshal(t *testing.T, v any) json.RawMessage {
	t.Helper()
	raw, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}
	return raw
}

// A payload the schema declares must be reachable from the Go event that
// carries it, or the two describe different bytes. Comparing the marshalled
// field sets catches a payload swapped for a similar one (ChatDeltaPayload vs
// ChatItemDeltaPayload, say), which the discriminator check alone would miss.
func TestEventPayloadFieldsMatchTheSchema(t *testing.T) {
	for _, payload := range allPayloads() {
		goFields := jsonFieldSet(reflect.TypeOf(payload))
		raw, _ := json.Marshal(map[string]any{
			"seq": 1, "type": payload.EventType(), "timestamp": "1970-01-01T00:00:00Z",
			"payload": map[string]any{},
		})
		var union api.ChatEventUnion
		if json.Unmarshal(raw, &union) != nil {
			continue
		}
		member, err := union.ValueByDiscriminator()
		if err != nil {
			continue // already reported above
		}
		schemaFields := jsonFieldSet(payloadFieldType(reflect.TypeOf(member)))
		for field := range goFields {
			if !schemaFields[field] {
				t.Errorf("%s: Go sends %q but the schema's payload has no such field", payload.EventType(), field)
			}
		}
	}
}

// payloadFieldType is the type of a schema member's `payload` field.
func payloadFieldType(member reflect.Type) reflect.Type {
	if field, ok := member.FieldByName("Payload"); ok {
		return field.Type
	}
	return nil
}

// jsonFieldSet is every json name a struct marshals, following embedded structs
// the way encoding/json promotes them.
func jsonFieldSet(typ reflect.Type) map[string]bool {
	out := map[string]bool{}
	if typ == nil || typ.Kind() != reflect.Struct {
		return out
	}
	for i := range typ.NumField() {
		field := typ.Field(i)
		if field.Anonymous && field.Type.Kind() == reflect.Struct {
			for name := range jsonFieldSet(field.Type) {
				out[name] = true
			}
			continue
		}
		if name := jsonName(field); name != "" && name != "-" {
			out[name] = true
		}
	}
	return out
}
