import { createHash } from 'node:crypto'
import path from 'node:path'
import { privateJson, stateRoot } from './store.js'

export function recordClaudeEvent(event, root = stateRoot(), now = Date.now()) {
  if (typeof event?.session_id !== 'string' || event.session_id.length > 256) return false
  const waiting = event.hook_event_name === 'PermissionRequest'
    || event.hook_event_name === 'Notification' && event.notification_type === 'permission_prompt'
  const cleared = ['PostToolUse', 'PostToolUseFailure', 'UserPromptSubmit', 'Stop', 'SessionEnd'].includes(event.hook_event_name)
  if (!waiting && !cleared) return false
  const id = createHash('sha256').update(event.session_id).digest('hex')
  // No prompt, tool arguments, transcript, directory, or credential is stored.
  privateJson(path.join(root, 'claude', `${id}.json`), { id, waiting, at: now })
  return true
}

export async function runClaudeHook(root) {
  let body = ''
  for await (const chunk of process.stdin) {
    body += chunk
    if (Buffer.byteLength(body) > 1024 * 1024) return
  }
  try { recordClaudeEvent(JSON.parse(body), root) } catch { /* Observation must never block Claude. */ }
  // No stdout / permissionDecision / control sequence: approval remains in Claude.
}
