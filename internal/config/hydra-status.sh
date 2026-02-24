#!/bin/bash
# hydra-status.sh
# Updates ~/.hydra/status.json with current Claude session status.
# Called by Claude Code hooks: SessionStart, Stop, SessionEnd.
node -e "
const fs = require('fs');
let raw = '';
process.stdin.on('data', c => raw += c);
process.stdin.on('end', () => {
  let input = {};
  try { input = JSON.parse(raw); } catch(e) {}
  const event = input.hook_event_name || '';
  const ts = new Date().toISOString();
  let status;
  if (event === 'SessionStart') status = 'starting';
  else if (event === 'Stop' || event === 'AfterAgent') status = 'waiting';
  else if (event === 'SessionEnd') status = 'ended';
  else status = 'unknown';
  const obj = { status, event, timestamp: ts };
  if ((event === 'Stop' || event === 'AfterAgent') && input.last_assistant_message) {
    obj.last_message = String(input.last_assistant_message).slice(0, 300);
  }
  if (event === 'SessionEnd' && input.reason) {
    obj.reason = String(input.reason);
  }
  const dir = process.env.HOME || '.';
  try { fs.writeFileSync(dir + '/.hydra/status.json', JSON.stringify(obj)); } catch(e) {}
});" 2>/dev/null
exit 0
