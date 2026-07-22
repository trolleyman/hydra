package heads

import (
	"log"
	"time"

	"braces.dev/errtrace"
	"github.com/trolleyman/hydra/internal/api"
	"github.com/trolleyman/hydra/internal/claudestream"
	"github.com/trolleyman/hydra/internal/codexstream"
	"github.com/trolleyman/hydra/internal/db"
	"github.com/trolleyman/hydra/internal/session"
)

// startCodexChatController attaches an internal observer to the app-server
// process, installs it as the session's provider-neutral input driver, and
// begins the initialize -> thread start/resume -> initial turn handshake.
func startCodexChatController(reg *session.Registry, store *db.Store, projectRoot, id, worktree, model, conversationID, initialPrompt string) error {
	att, err := reg.Attach(id, 0, 0)
	if err != nil {
		return errtrace.Wrap(err)
	}
	controller := codexstream.New(codexstream.Options{
		CWD: worktree, Model: model, ConversationID: conversationID, InitialPrompt: initialPrompt,
		Send: func(line []byte) error { return errtrace.Wrap(reg.Write(id, line)) },
		OnConversation: func(threadID string) {
			if err := store.UpdateAgentConversationID(id, threadID); err != nil {
				log.Printf("warn: persist Codex thread for %s: %v", id, err)
			}
		},
		OnTurnStart: func(string) {
			if err := MarkPromptSubmitted(store, projectRoot, id); err != nil {
				log.Printf("warn: mark Codex turn running for %s: %v", id, err)
			}
		},
		OnTurnEnd: func(string) {
			reg.ChatTurnEnded(id)
		},
		OnError: func(controllerErr error) {
			log.Printf("warn: Codex app-server for %s: %v", id, controllerErr)
			ts := time.Now().Format(time.RFC3339Nano)
			_ = WriteAgentStatus(projectRoot, id, &api.AgentStatusInfo{Status: api.Errored, LastMessage: stringPtr(controllerErr.Error()), Timestamp: ts})
			_ = store.UpdateAgentStatus(id, string(api.Errored), ts, true)
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
