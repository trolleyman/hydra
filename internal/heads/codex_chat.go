package heads

import (
	"log"
	"os"
	"path/filepath"
	"strings"
	"time"

	"braces.dev/errtrace"
	"github.com/trolleyman/hydra/internal/api"
	"github.com/trolleyman/hydra/internal/claudestream"
	"github.com/trolleyman/hydra/internal/codexstream"
	"github.com/trolleyman/hydra/internal/db"
	"github.com/trolleyman/hydra/internal/paths"
	"github.com/trolleyman/hydra/internal/session"
)

// startCodexChatController attaches an internal observer to the app-server
// process, installs it as the session's provider-neutral input driver, and
// begins the initialize -> thread start/resume -> initial turn handshake.
func startCodexChatController(reg *session.Registry, store *db.Store, projectRoot, id, worktree, model, effort, conversationID, initialPrompt string) error {
	att, err := reg.Attach(id, 0, 0)
	if err != nil {
		return errtrace.Wrap(err)
	}
	controller := codexstream.New(codexstream.Options{
		CWD: worktree, Model: model, Effort: effort, ConversationID: conversationID, InitialPrompt: initialPrompt,
		Send: func(line []byte) error { return errtrace.Wrap(reg.Write(id, line)) },
		OnConversation: func(threadID string) {
			if store == nil {
				if err := writeCodexSlotConversationID(projectRoot, id, threadID); err != nil {
					log.Printf("warn: persist Codex slot thread for %s: %v", id, err)
				}
				return
			}
			if err := store.UpdateAgentConversationID(id, threadID); err != nil {
				log.Printf("warn: persist Codex thread for %s: %v", id, err)
			}
		},
		OnModel: func(model string) { reg.ObserveChatModel(id, model) },
		OnTurnStart: func(string) {
			if store == nil {
				writeCodexSlotRunning(projectRoot, id)
				return
			}
			if err := MarkPromptSubmitted(store, projectRoot, id); err != nil {
				log.Printf("warn: mark Codex turn running for %s: %v", id, err)
			}
		},
		OnActivity: func(detail string) {
			writeCodexLatest(projectRoot, id, api.Running, detail, boolPtr(false))
		},
		OnMessage: func(message string) {
			writeCodexLatest(projectRoot, id, api.Running, message, nil)
		},
		OnNeedsInput: func(question string) {
			ts := time.Now().Format(time.RFC3339Nano)
			event := "request_user_input"
			info := &api.AgentStatusInfo{Status: api.NeedsInput, Event: &event, Timestamp: ts}
			if question != "" {
				info.LastMessage = stringPtr(question)
				info.LastMessageIsSuggestedNextMessage = boolPtr(false)
			}
			if err := WriteAgentStatus(projectRoot, id, info); err != nil {
				log.Printf("warn: mark Codex user-input request for %s: %v", id, err)
				return
			}
			if store != nil {
				if err := store.UpdateAgentStatus(id, string(api.NeedsInput), ts, true); err != nil {
					log.Printf("warn: persist Codex user-input request for %s: %v", id, err)
				}
			}
		},
		OnStep: func() {
			reg.ChatStep(id)
		},
		OnTurnEnd: func(string) {
			reg.ChatTurnEnded(id)
		},
		OnHistoryLine: func(line []byte) { reg.ObserveChatLine(id, "codex_history", line) },
		OnError: func(controllerErr error) {
			log.Printf("warn: Codex app-server for %s: %v", id, controllerErr)
			ts := time.Now().Format(time.RFC3339Nano)
			_ = WriteAgentStatus(projectRoot, id, &api.AgentStatusInfo{Status: api.Errored, LastMessage: stringPtr(controllerErr.Error()), Timestamp: ts})
			if store != nil {
				_ = store.UpdateAgentStatus(id, string(api.Errored), ts, true)
			}
		},
	})
	if err := reg.SetChatDriver(id, controller); err != nil {
		att.Close()
		return errtrace.Wrap(err)
	}
	go func() {
		defer att.Close()
		lb := &claudestream.LineBuffer{}
		for {
			select {
			case <-att.Done:
				return
			case chunk, ok := <-att.Output:
				if !ok {
					return
				}
				for _, line := range lb.Feed(chunk) {
					controller.OnLine(line)
				}
			}
		}
	}()
	if err := controller.Start(); err != nil {
		att.Close()
		return errtrace.Wrap(err)
	}
	return nil
}

func stringPtr(value string) *string { return &value }

func writeCodexSlotRunning(projectRoot, id string) {
	ts := time.Now().Format(time.RFC3339Nano)
	if err := WriteAgentStatus(projectRoot, id, &api.AgentStatusInfo{Status: api.Running, Timestamp: ts}); err != nil {
		log.Printf("warn: mark Codex slot activity running for %s: %v", id, err)
	}
}

// writeCodexLatest persists Codex's newest meaningful transcript item in both
// status fields. Activity drives the line while the turn is running;
// LastMessage carries the same item across the running -> finished edge. A
// later assistant message naturally replaces the preceding tool description.
func writeCodexLatest(projectRoot, id string, status api.AgentStatus, detail string, suggested *bool) {
	ts := time.Now().Format(time.RFC3339Nano)
	info := &api.AgentStatusInfo{Status: status, Timestamp: ts}
	if detail != "" {
		info.Activity = stringPtr(detail)
		info.LastMessage = stringPtr(detail)
		info.LastMessageIsSuggestedNextMessage = suggested
	} else if current := ReadAgentStatus(projectRoot, id); current != nil {
		// Reasoning and the start of an agent-message item are lifecycle edges,
		// not newer user-facing things. Keep the previous tool/message visible
		// until Codex supplies actual message text.
		info.Activity = current.Activity
		info.LastMessage = current.LastMessage
		info.LastMessageIsSuggestedNextMessage = current.LastMessageIsSuggestedNextMessage
	}
	if err := WriteAgentStatus(projectRoot, id, info); err != nil {
		log.Printf("warn: persist Codex latest activity for %s: %v", id, err)
	}
}

func boolPtr(value bool) *bool { return &value }

func codexSlotConversationIDPath(projectRoot, id string) string {
	return filepath.Join(paths.GetCacheDirFromProjectRoot(projectRoot), id+"-codex-conversation-id")
}

func readCodexSlotConversationID(projectRoot, id string) string {
	data, err := os.ReadFile(codexSlotConversationIDPath(projectRoot, id))
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(data))
}

func writeCodexSlotConversationID(projectRoot, id, conversationID string) error {
	file := codexSlotConversationIDPath(projectRoot, id)
	if err := os.MkdirAll(filepath.Dir(file), 0o755); err != nil {
		return errtrace.Wrap(err)
	}
	return errtrace.Wrap(os.WriteFile(file, []byte(conversationID+"\n"), 0o600))
}

func removeCodexSlotConversationID(projectRoot, id string) {
	if err := os.Remove(codexSlotConversationIDPath(projectRoot, id)); err != nil && !os.IsNotExist(err) {
		log.Printf("warn: purge remove Codex slot thread for %s: %v", id, err)
	}
}
