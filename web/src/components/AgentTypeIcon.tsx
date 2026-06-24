import { Layers } from 'lucide-react'
import type { SVGProps } from 'react'

// Small brand-ish marks for each agent type, used by the settings Agent selector
// (and reusable elsewhere). They inherit `currentColor` so the caller tints them
// with the agent's accent colour. Deliberately simple, recognizable shapes rather
// than pixel-exact logos. Codex is included ahead of the agent existing so the
// selector can light it up the moment it's added.
export type AgentTypeIconName = 'all' | 'claude' | 'gemini' | 'copilot' | 'codex'

export function AgentTypeIcon({ name, ...props }: { name: AgentTypeIconName } & SVGProps<SVGSVGElement>) {
  switch (name) {
    case 'claude':
      // Anthropic-style radiating burst (8-point sparkle).
      return (
        <svg viewBox="0 0 24 24" fill="currentColor" {...props}>
          <path d="M12 1.5c.45 0 .83.32.92.76l1.1 5.02 3.6-3.6a.94.94 0 0 1 1.33 1.33l-3.6 3.6 5.02 1.1a.94.94 0 0 1 0 1.84l-5.02 1.1 3.6 3.6a.94.94 0 0 1-1.33 1.33l-3.6-3.6-1.1 5.02a.94.94 0 0 1-1.84 0l-1.1-5.02-3.6 3.6a.94.94 0 0 1-1.33-1.33l3.6-3.6-5.02-1.1a.94.94 0 0 1 0-1.84l5.02-1.1-3.6-3.6A.94.94 0 0 1 5.38 4.7l3.6 3.6 1.1-5.02c.09-.44.47-.76.92-.76z" />
        </svg>
      )
    case 'gemini':
      // Gemini-style four-point star.
      return (
        <svg viewBox="0 0 24 24" fill="currentColor" {...props}>
          <path d="M12 1.8c.55 5.6 3.8 8.85 9.4 9.4-5.6.55-8.85 3.8-9.4 9.4-.55-5.6-3.8-8.85-9.4-9.4 5.6-.55 8.85-3.8 9.4-9.4z" />
        </svg>
      )
    case 'copilot':
      // Copilot-style rounded face with two eyes.
      return (
        <svg viewBox="0 0 24 24" fill="currentColor" {...props}>
          <path d="M4 12.5C4 8.4 7 6 12 6s8 2.4 8 6.5c0 3.6-3 5.5-8 5.5s-8-1.9-8-5.5z" opacity="0.18" />
          <path
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            d="M4 12.5C4 8.4 7 6 12 6s8 2.4 8 6.5c0 3.6-3 5.5-8 5.5s-8-1.9-8-5.5z"
          />
          <circle cx="9" cy="12.6" r="1.4" />
          <circle cx="15" cy="12.6" r="1.4" />
        </svg>
      )
    case 'codex':
      // OpenAI-style six-petal blossom.
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" {...props}>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 3v18M4.2 7.5l15.6 9M4.2 16.5l15.6-9" strokeLinecap="round" />
        </svg>
      )
    case 'all':
    default:
      return <Layers {...(props as object)} />
  }
}
