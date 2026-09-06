// Package agenthost runs one provider-neutral local chat over a newline-delimited
// stdin/stdout protocol. It contains no Hydra HTTP, project, or worktree state.
package agenthost

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sync"

	"braces.dev/errtrace"
	"github.com/trolleyman/hydra/internal/agenthostapi"
	"github.com/trolleyman/hydra/internal/chat"
	"github.com/trolleyman/hydra/internal/policyapi"
)

const ProtocolVersion = 1

const initialHistoryLimit = 100

type writer struct {
	mu  sync.Mutex
	enc *json.Encoder
}

func (w *writer) write(frame any) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	return errtrace.Wrap(w.enc.Encode(frame))
}

// Run serves one agent-host connection until shutdown, EOF, cancellation, or a
// fatal protocol error. version is the build version reported to the extension.
func Run(ctx context.Context, in io.Reader, out, logOutput io.Writer, version string) error {
	w := &writer{enc: json.NewEncoder(out)}
	if err := w.write(agenthostapi.HelloFrame{
		Type:            agenthostapi.Hello,
		ProtocolVersion: ProtocolVersion,
		HostVersion:     version,
	}); err != nil {
		return errtrace.Wrap(err)
	}

	scanner := bufio.NewScanner(in)
	scanner.Buffer(make([]byte, 64*1024), 16*1024*1024)
	var store *chat.Store
	var policy policyapi.EffectivePolicy
	for scanner.Scan() {
		select {
		case <-ctx.Done():
			return errtrace.Wrap(ctx.Err())
		default:
		}
		line := append([]byte(nil), scanner.Bytes()...)
		var command agenthostapi.HostCommand
		if err := json.Unmarshal(line, &command); err != nil {
			_ = writeError(w, "", "invalid_json", err.Error(), false)
			continue
		}
		value, err := command.ValueByDiscriminator()
		if err != nil {
			_ = writeError(w, requestID(line), "unknown_command", err.Error(), false)
			continue
		}

		if store == nil {
			init, ok := value.(agenthostapi.InitializeCommand)
			if !ok {
				_ = writeError(w, requestID(line), "not_initialized", "initialize must be the first command", true)
				return errtrace.Wrap(errors.New("agent host command before initialize"))
			}
			if init.ProtocolVersion != ProtocolVersion {
				message := fmt.Sprintf("protocol version %d is unsupported; host requires %d", init.ProtocolVersion, ProtocolVersion)
				_ = writeError(w, "", "protocol_mismatch", message, true)
				return errtrace.Wrap(errors.New(message))
			}
			workspace, err := canonicalDirectory(init.Workspace)
			if err != nil {
				_ = writeError(w, "", "invalid_workspace", err.Error(), true)
				return errtrace.Wrap(err)
			}
			if init.Policy.Workspace != workspace {
				err := fmt.Errorf("policy workspace %q does not match canonical workspace %q", init.Policy.Workspace, workspace)
				_ = writeError(w, "", "invalid_policy", err.Error(), true)
				return errtrace.Wrap(err)
			}
			if !filepath.IsAbs(init.ConversationDir) {
				err := errors.New("conversation_dir must be absolute")
				_ = writeError(w, "", "invalid_conversation", err.Error(), true)
				return errtrace.Wrap(err)
			}
			store, err = chat.OpenDirectory(filepath.Clean(init.ConversationDir))
			if err != nil {
				_ = writeError(w, "", "open_conversation", err.Error(), true)
				return errtrace.Wrap(err)
			}
			policy = init.Policy
			if err := writeReplay(w, store); err != nil {
				return errtrace.Wrap(err)
			}
			if err := w.write(agenthostapi.ReadyFrame{Type: agenthostapi.Ready, Provider: policy.Provider, SessionId: init.ResumeSessionId}); err != nil {
				return errtrace.Wrap(err)
			}
			continue
		}

		switch command := value.(type) {
		case agenthostapi.UserMessageCommand:
			content, err := json.Marshal(command.Content)
			if err != nil {
				_ = writeResult(w, command.RequestId, err)
				continue
			}
			message := chat.UserMessage{}
			message.Id, message.Content = command.Id, content
			event, err := store.Append(message)
			if err == nil {
				err = w.write(agenthostapi.ChatEventFrame{Type: agenthostapi.ChatEvent, Event: event})
			}
			_ = writeResult(w, command.RequestId, err)
		case agenthostapi.LoadEventsBeforeCommand:
			events, next, done, err := store.Before(command.Cursor, command.Limit)
			if err != nil {
				_ = writeResult(w, command.RequestId, err)
				continue
			}
			_ = w.write(agenthostapi.ChatHistoryFrame{Type: agenthostapi.ChatHistory, RequestId: command.RequestId, Events: events, NextCursor: next, Done: done})
		case agenthostapi.LoadSubagentCommand:
			_ = w.write(agenthostapi.SubagentEventsFrame{Type: agenthostapi.SubagentEvents, RequestId: command.RequestId, AgentId: command.AgentId, Events: store.SubagentEvents(command.AgentId)})
		case agenthostapi.UpdatePolicyCommand:
			if command.Policy.Workspace != policy.Workspace {
				_ = writeResult(w, command.RequestId, errors.New("an updated policy cannot change the conversation workspace"))
				continue
			}
			policy = command.Policy
			_ = writeResult(w, command.RequestId, nil)
		case agenthostapi.ShutdownCommand:
			store.Checkpoint()
			return nil
		case agenthostapi.InterruptCommand:
			_ = writeResult(w, command.RequestId, errors.New("no provider is running"))
		case agenthostapi.SetModelCommand:
			_ = writeResult(w, command.RequestId, errors.New("no provider is running"))
		case agenthostapi.ControlResponseCommand:
			_ = writeResult(w, command.RequestId, errors.New("no provider interaction is pending"))
		case agenthostapi.ApprovalResponseCommand:
			_ = writeResult(w, command.RequestId, errors.New("no approval is pending"))
		default:
			fmt.Fprintf(logOutput, "agent-host: ignored decoded command %T\n", value)
		}
	}
	if store != nil {
		store.Checkpoint()
	}
	if err := scanner.Err(); err != nil {
		return errtrace.Wrap(err)
	}
	return nil
}

func canonicalDirectory(path string) (string, error) {
	if !filepath.IsAbs(path) {
		return "", errtrace.Wrap(errors.New("workspace must be absolute"))
	}
	canonical, err := filepath.EvalSymlinks(filepath.Clean(path))
	if err != nil {
		return "", errtrace.Wrap(fmt.Errorf("resolve workspace: %w", err))
	}
	info, err := os.Stat(canonical)
	if err != nil {
		return "", errtrace.Wrap(fmt.Errorf("inspect workspace: %w", err))
	}
	if !info.IsDir() {
		return "", errtrace.Wrap(errors.New("workspace is not a directory"))
	}
	return canonical, nil
}

func writeReplay(w *writer, store *chat.Store) error {
	if err := w.write(agenthostapi.StateSnapshotFrame{Type: agenthostapi.StateSnapshot, Projection: store.Snapshot()}); err != nil {
		return errtrace.Wrap(err)
	}
	events, next, done, err := store.Before("", initialHistoryLimit)
	if err != nil {
		return errtrace.Wrap(err)
	}
	if err := w.write(agenthostapi.ChatHistoryFrame{Type: agenthostapi.ChatHistory, Events: events, NextCursor: next, Done: done}); err != nil {
		return errtrace.Wrap(err)
	}
	return errtrace.Wrap(w.write(agenthostapi.ReplayDoneFrame{Type: agenthostapi.ReplayDone}))
}

func writeResult(w *writer, requestID string, result error) error {
	frame := agenthostapi.OperationResultFrame{Type: agenthostapi.OperationResult, RequestId: requestID, Ok: result == nil}
	if result != nil {
		frame.Error = result.Error()
	}
	return errtrace.Wrap(w.write(frame))
}

func writeError(w *writer, requestID, code, message string, fatal bool) error {
	return errtrace.Wrap(w.write(agenthostapi.HostErrorFrame{Type: agenthostapi.HostError, RequestId: requestID, Code: code, Message: message, Fatal: fatal}))
}

func requestID(line []byte) string {
	var envelope struct {
		RequestID string `json:"request_id"`
	}
	_ = json.Unmarshal(line, &envelope)
	return envelope.RequestID
}
