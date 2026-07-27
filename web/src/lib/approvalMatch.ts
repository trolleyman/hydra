import type { ApprovalRequest } from '../api'
import { parseHostRunScript } from './bashFormat'

// approvalMatchesTool decides whether a parked security-gate request belongs to a
// given tool card in the chat transcript, so the card the head is actually
// blocked in can carry its own Allow / Deny buttons instead of only the toast.
//
// The gate records the tool name it parked on (`tool`), which is the tool_use
// name the transcript already shows - so for everything the gate parks that is
// the match. `hydra host-run` is the exception: it is not a gated tool call but a
// plain Bash command the agent ran, which then asked for approval from inside, so
// it is matched by recognising the host-run invocation in the command itself.
//
// A false positive here would put Allow/Deny on the wrong card, so both arms are
// deliberately strict: no "it's the only pending tool" guessing.
export function approvalMatchesTool(
  approval: ApprovalRequest,
  toolName: string,
  input: Record<string, unknown> | null,
): boolean {
  if (approval.kind === 'host_command') {
    if (toolName !== 'Bash') return false
    const command = typeof input?.command === 'string' ? input.command : ''
    const script = parseHostRunScript(command)
    if (script === null) return false
    const target = (approval.target ?? '').trim()
    // The CLI renders the request from the argv it was given, so the script we
    // parse out of the command is normally byte-identical; a differently-quoted
    // rendering still leaves the script text inside the command.
    return script.trim() === target || command.includes(target)
  }
  // 'egress' is raised by the proxy for a connection, not a tool call, so it has
  // no card to attach to; every other kind names its tool.
  if (approval.kind === 'egress' || !approval.tool) return false
  if (approval.tool !== toolName) return false
  // A WebFetch card is only THE one if it asks for the same URL (a transcript can
  // hold many).
  if (approval.kind === 'webfetch' && approval.url) {
    return typeof input?.url === 'string' && input.url === approval.url
  }
  return true
}
