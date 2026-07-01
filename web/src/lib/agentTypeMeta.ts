import type { AgentTypeIconName } from '../components/AgentTypeIcon'

// Accent colours matched to each brand's canonical logo colour, with a lightened
// variant for dark mode where the brand colour would be too dark to read. Claude
// #D97757, Gemini #8E75B2; GitHub Copilot and OpenAI are monochrome (near-black on
// light, near-white on dark). Single source of truth so every call site agrees.
export const AGENT_ACCENT: Record<AgentTypeIconName, string> = {
  all: 'text-blue-600 dark:text-blue-400',
  claude: 'text-[#D97757]',
  gemini: 'text-[#8E75B2] dark:text-[#A88FC9]',
  copilot: 'text-[#1F2328] dark:text-[#E6EDF3]',
  codex: 'text-[#0D0D0D] dark:text-[#ECECEC]',
}
