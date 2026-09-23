const enabled = document.querySelector('#enabled')
const claudeAuto = document.querySelector('#claude-auto')
const error = document.querySelector('#error')
let saving = false
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`
async function refresh() {
  try {
    const response = await fetch('/api/status')
    if (!response.ok) throw new Error('The companion is unavailable. Reload this page to reconnect.')
    const state = await response.json()
    document.querySelector('#connection').textContent = state.connected ? 'Connected to Codex.' : 'Waiting for Codex to open through the companion. Existing running sessions stay untouched.'
    if (!saving) {
      enabled.checked = state.enabled; enabled.disabled = false
      claudeAuto.checked = state.claudeAutoApprove; claudeAuto.disabled = false
    }
    document.querySelector('#empty').hidden = state.tasks.length > 0
    const table = document.querySelector('#tasks'); table.hidden = state.tasks.length === 0
    const rows = state.tasks.map(task => {
      const row = document.createElement('tr')
      const cell = document.createElement('td')
      const link = document.createElement('a')
      link.href = `codex://threads/${encodeURIComponent(task.threadId)}`
      link.textContent = task.threadId.slice(0, 8); link.title = task.threadId
      cell.append(link); row.append(cell)
      for (const text of [task.state, new Date(task.at).toLocaleTimeString()]) { const td = document.createElement('td'); td.textContent = text; row.append(td) }
      return row
    })
    table.querySelector('tbody').replaceChildren(...rows)
    const accepted = state.claudeApproved ? `Accepted ${plural(state.claudeApproved, 'prompt')} in the last 24 hours.` : ''
    const waiting = state.claude.length ? `${plural(state.claude.length, 'session')} waiting on a prompt in Claude Code.` : ''
    document.querySelector('#claude').textContent = [accepted, waiting].filter(Boolean).join(' ') || 'No permission prompts detected.'
    error.textContent = ''
  } catch (e) { enabled.disabled = true; claudeAuto.disabled = true; error.textContent = e.message }
}
function saveOnChange(input, key, failure) {
  input.addEventListener('change', async () => {
    saving = true; input.disabled = true
    try {
      const response = await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ [key]: input.checked }) })
      if (!response.ok) throw new Error(failure)
    } catch (e) { error.textContent = e.message } finally { saving = false; await refresh() }
  })
}
saveOnChange(enabled, 'enabled', 'Could not change automatic retries.')
saveOnChange(claudeAuto, 'claudeAutoApprove', 'Could not change automatic Claude approvals.')
void refresh(); setInterval(refresh, 5000)
