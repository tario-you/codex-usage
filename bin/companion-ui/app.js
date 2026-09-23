const enabled = document.querySelector('#enabled')
const error = document.querySelector('#error')
let saving = false
async function refresh() {
  try {
    const response = await fetch('/api/status')
    if (!response.ok) throw new Error('The companion is unavailable. Reload this page to reconnect.')
    const state = await response.json()
    document.querySelector('#connection').textContent = state.connected ? 'Connected to Codex.' : 'Waiting for Codex to open through the companion. Existing running sessions stay untouched.'
    if (!saving) { enabled.checked = state.enabled; enabled.disabled = false }
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
    document.querySelector('#claude').textContent = state.claude.length ? `${state.claude.length} session${state.claude.length === 1 ? '' : 's'} reported a permission prompt. Review in Claude Code.` : 'No permission prompts detected.'
    error.textContent = ''
  } catch (e) { enabled.disabled = true; error.textContent = e.message }
}
enabled.addEventListener('change', async () => {
  saving = true; enabled.disabled = true
  try {
    const response = await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: enabled.checked }) })
    if (!response.ok) throw new Error('Could not change automatic retries.')
  } catch (e) { error.textContent = e.message } finally { saving = false; await refresh() }
})
void refresh(); setInterval(refresh, 5000)
