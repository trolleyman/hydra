import type { AgentResponse } from '../api'

// Agent-directed base merges must name the correct write surface. Under
// read-only git isolation, raw git cannot update the worktree's metadata and the
// Hydra merge tools are the normal path (not host-run). With isolation off, the
// ordinary in-sandbox git command is both available and simpler.
export function mergeBaseInstruction(agent: AgentResponse, alreadyConflicted: boolean): string {
  const base = agent.base_branch
  const goal = alreadyConflicted
    ? `Fix the merge conflicts by merging the local \`${base}\` branch into this one`
    : `Update this branch from its base by merging the local \`${base}\` branch in`
  if (agent.git_isolation === 'readonly') {
    return `${goal} (do not git fetch first). Use the \`mcp__hydra__git_merge\` tool, not host-run or raw git merge; resolve any conflicts it leaves, then use \`mcp__hydra__git_merge_continue\`.`
  }
  return `${goal} (do not git fetch first). Run \`git merge ${base}\` directly in the sandbox, not through host-run, and resolve any conflicts that arise.`
}
