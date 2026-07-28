import { createContext } from 'react'

// The provider ("claude" / "gemini" / "copilot" / "codex") whose chat is being
// rendered, published once by ChatPane so deep chrome inside the transcript can
// take the head's brand accent without every card threading a prop down. Read
// it through agentTypeColor (lib/agentDisplay) so the hue matches the same
// agent's logo mark everywhere else in the UI.
//
// Only chrome should read this - message content is provider-neutral. The
// default keeps a stray consumer outside a provider on Claude's accent, which
// is what the chat used unconditionally before.
export const ChatAgentTypeContext = createContext<string>('claude')
