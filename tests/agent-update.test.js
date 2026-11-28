import assert from 'node:assert/strict'
import test from 'node:test'

import { installedRevision, planUpdate } from '../scripts/update-switcher-health-sync.mjs'

const A = 'a55f8410eafe44e818ef83130d57c7014f5aa2e0'
const B = '29cb447c5467c0c463b6cd95232ba00c39921e2d'

test('the installed commit comes from the sync release path', () => {
  assert.equal(installedRevision(['/opt/homebrew/bin/node', `/Users/x/.local/share/codex-usage/sync-agent/${A}/bin/switcher-health-agent.js`, '/Users/x/.codex/codex-usage-sync.json']), A)
  assert.equal(installedRevision(['/opt/homebrew/bin/node', '/Users/x/codex-usage/bin/switcher-health-agent.js']), null)
  assert.equal(installedRevision(undefined), null)
})

test('a merged change to a sync file installs; anything else waits', () => {
  assert.equal(planUpdate({ installed: A, target: B, onMaster: true, agentChanged: true }), 'install')
  assert.equal(planUpdate({ installed: B, target: B, onMaster: true, agentChanged: false }), 'current')
  assert.equal(planUpdate({ installed: A, target: B, onMaster: true, agentChanged: false }), 'unchanged', 'a dashboard-only merge does not restart the sync')
  assert.equal(planUpdate({ installed: A, target: B, onMaster: false, agentChanged: null }), 'kept', 'a sync installed by hand before its merge stays')
  assert.equal(planUpdate({ installed: null, target: B, onMaster: false, agentChanged: null }), 'kept', 'a sync this cannot read is left alone')
})
