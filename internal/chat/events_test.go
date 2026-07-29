package chat

import (
	"encoding/json"
	"reflect"
	"testing"

	"github.com/trolleyman/hydra/internal/api"
)

// The whole point of embedding the provider context rather than repeating its
// eight fields is that encoding/json promotes them, so the wire stays exactly
// as flat as the schema describes. If Go ever stopped doing that - or a payload
// grew a field whose json tag collides with the context's, which makes
// encoding/json silently drop BOTH - the log format would change under us.
func TestEmbeddedPayloadsMarshalFlat(t *testing.T) {
	ev := AssistantMessage{}
	ev.Uuid = "u1"
	ev.Sidechain = true
	ev.AgentId = "sub-1"
	ev.MessageId = "msg-1"
	ev.Text = "hello"

	raw, err := json.Marshal(ev)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var got map[string]any
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	want := map[string]any{
		"uuid": "u1", "sidechain": true, "agent_id": "sub-1",
		"message_id": "msg-1", "text": "hello",
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("marshalled %s, want the context and payload fields flat and unset ones omitted", raw)
	}
}

// A payload whose json tag collides with the context's is the failure mode that
// silently loses data, so assert the two that were caught (and fixed) stay
// fixed. `go vet` also flags this, but only for types it can see embedded.
func TestNoPayloadTagCollidesWithContext(t *testing.T) {
	contextTags := map[string]bool{}
	ctx := reflect.TypeFor[api.ChatProviderContext]()
	for i := range ctx.NumField() {
		contextTags[jsonName(ctx.Field(i))] = true
	}
	for _, p := range []Payload{
		UserMessage{}, ContextMessage{}, AssistantMessage{}, AssistantDelta{},
		ReasoningCompleted{}, ReasoningDelta{}, ContentStreamStarted{}, ToolStarted{},
		ToolCompleted{}, ToolDelta{}, PlanUpdated{}, PlanDelta{}, SubagentStarted{},
		SubagentCompleted{}, TurnStarted{}, TurnCompleted{}, TurnFailed{}, TurnError{},
		MessagesRetracted{}, Notice{}, InteractionRequested{},
	} {
		typ := reflect.TypeOf(p)
		// Field 1 is the embedded payload; field 0 is the context.
		payload := typ.Field(1).Type
		for i := range payload.NumField() {
			if name := jsonName(payload.Field(i)); contextTags[name] {
				t.Errorf("%s: payload field %q collides with ChatProviderContext, so encoding/json drops both", typ.Name(), name)
			}
		}
	}
}

func jsonName(f reflect.StructField) string {
	tag := f.Tag.Get("json")
	for i := range len(tag) {
		if tag[i] == ',' {
			return tag[:i]
		}
	}
	return tag
}
