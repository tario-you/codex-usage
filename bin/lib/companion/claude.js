import { createHash } from 'node:crypto'
import path from 'node:path'
import { privateJson, readJson, stateRoot } from './store.js'

// These tools ask the person a question (answers, plan review); an automatic
// "allow" would submit them unanswered, so they always stay in Claude.
export const NEEDS_PERSON = new Set(['AskUserQuestion', 'ExitPlanMode'])

export function autoApproveEnabled(root = stateRoot()) {
  try { return readJson(path.join(root, 'settings.json'), {}).claudeAutoApprove !== false } catch { return false }
}

// Only reached when Claude would show a dialog: deny rules and hook denials
// have already refused the call, so they are never overridden here.
export function claudeDecision(event, root = stateRoot()) {
  if (event?.hook_event_name !== 'PermissionRequest' || typeof event.tool_name !== 'string') return null
  if (NEEDS_PERSON.has(event.tool_name) || !autoApproveEnabled(root)) return null
  return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } }
}

export function recordClaudeEvent(event, root = stateRoot(), now = Date.now(), approved = false) {
  if (typeof event?.session_id !== 'string' || event.session_id.length > 256) return false
  const waiting = !approved && (event.hook_event_name === 'PermissionRequest'
    || event.hook_event_name === 'Notification' && event.notification_type === 'permission_prompt')
  const cleared = approved || ['PostToolUse', 'PostToolUseFailure', 'UserPromptSubmit', 'Stop', 'SessionEnd'].includes(event.hook_event_name)
  if (!waiting && !cleared) return false
  const id = createHash('sha256').update(event.session_id).digest('hex')
  const file = path.join(root, 'claude', `${id}.json`)
  let previous = {}
  try { previous = readJson(file, {}) ?? {} } catch { /* A damaged record restarts its count. */ }
  const approvals = Number.isInteger(previous.approvals) ? previous.approvals : 0
  // No prompt, tool name, arguments, transcript, directory, or credential is stored.
  privateJson(file, {
    id, waiting, at: now,
    ...(approved ? { approvals: approvals + 1, approvedAt: now } : approvals ? { approvals, approvedAt: previous.approvedAt } : {}),
  })
  return true
}

export async function runClaudeHook(root) {
  let body = ''
  for await (const chunk of process.stdin) {
    body += chunk
    if (Buffer.byteLength(body) > 1024 * 1024) return
  }
  let event
  try { event = JSON.parse(body) } catch { return }
  let decision = null
  try { decision = claudeDecision(event, root) } catch { /* Unknown state leaves the prompt to the person. */ }
  try { recordClaudeEvent(event, root, Date.now(), decision !== null) } catch { /* Observation must never block Claude. */ }
  if (decision) process.stdout.write(JSON.stringify(decision))
}
