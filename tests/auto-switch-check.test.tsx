// her-team#4148: a plan row carries a verified check when the reporting
// machine's auto-switcher can switch to it, and the check explains itself.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { accountStateSchema } from '../api/_lib/schemas.ts'
import { readClaudeAutoSwitchPool } from '../bin/lib/claude-logins.js'
import { buildSyncPayloadFromUsage } from '../bin/lib/sync-all.js'
import { TooltipProvider } from '../src/components/ui/tooltip.tsx'
import { AutoSwitchCheck } from '../src/features/dashboard/auto-switch-check.tsx'
import { autoSwitchExplanation, readAutoSwitchMark } from '../src/features/dashboard/auto-switch-mark.ts'

test("claude-auto-switch's pool is its saved logins it can refresh and hasn't turned off", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'codex-usage-pool-'))
  t.after(() => rm(dir, { force: true, recursive: true }))
  const storePath = path.join(dir, 'accounts.json')
  assert.equal(await readClaudeAutoSwitchPool(storePath), null, 'no store on this machine: unknown, never "not in the pool"')
  await writeFile(storePath, JSON.stringify({ version: 1, accounts: [
    { email: 'In@Example.com', oauth: { accessToken: 'a', refreshToken: 'r' } },
    { email: 'off@example.com', auto_switch_enabled: false, oauth: { accessToken: 'a', refreshToken: 'r' } },
    { email: 'norefresh@example.com', oauth: { accessToken: 'a' } },
  ] }))
  assert.deepEqual([...await readClaudeAutoSwitchPool(storePath)], ['in@example.com'])
})

// her-team#15046: a login the switcher set aside (its excluded.json, by email or account uuid) is never a switch target.
test("a login claude-auto-switch set aside is out of its pool", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'codex-usage-pool-'))
  t.after(() => rm(dir, { force: true, recursive: true }))
  const storePath = path.join(dir, 'accounts.json')
  await writeFile(storePath, JSON.stringify({ version: 1, accounts: [
    { email: 'in@example.com', oauth: { accessToken: 'a', refreshToken: 'r' } },
    { email: 'Aside@example.com', oauth: { accessToken: 'a', refreshToken: 'r' } },
    { email: 'byuuid@example.com', account_uuid: 'AB12CD34-0000-4000-8000-000000000001', oauth: { accessToken: 'a', refreshToken: 'r' } },
  ] }))
  await writeFile(path.join(dir, 'excluded.json'), JSON.stringify({ version: 1, excluded: {
    'email:aside@example.com': { at: '2026-10-16T06:50:34Z', why: 'set aside' },
    'uuid:ab12cd34-0000-4000-8000-000000000001': { at: '2026-10-06T19:00:00Z', why: 'set aside' },
  } }))
  assert.deepEqual([...await readClaudeAutoSwitchPool(storePath)], ['in@example.com'])
})

// her-team#16548: the switcher moves the Claude app onto a plan it keeps an app sign-in copy of, terminal login or none.
test("a plan claude-auto-switch keeps an app sign-in copy of is in its pool unless set aside", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'codex-usage-pool-'))
  t.after(() => rm(dir, { force: true, recursive: true }))
  const storePath = path.join(dir, 'accounts.json')
  await writeFile(storePath, JSON.stringify({ version: 1, accounts: [{ email: 'in@example.com', oauth: { accessToken: 'a', refreshToken: 'r' } }] }))
  const copy = async (uuid: string, meta: unknown) => {
    await mkdir(path.join(dir, 'desktop-logins', uuid), { recursive: true })
    await writeFile(path.join(dir, 'desktop-logins', uuid, 'meta.json'), JSON.stringify(meta))
  }
  await copy('00000000-0000-4000-8000-00000000000a', { accountUuid: '00000000-0000-4000-8000-00000000000a', email: 'App@Example.com' })
  await copy('00000000-0000-4000-8000-00000000000b', { accountUuid: '00000000-0000-4000-8000-00000000000b', email: 'aside@example.com' })
  await mkdir(path.join(dir, 'desktop-logins', 'backups'), { recursive: true })
  await writeFile(path.join(dir, 'excluded.json'), JSON.stringify({ version: 1, excluded: { 'uuid:00000000-0000-4000-8000-00000000000b': { at: '2026-10-16T06:50:34Z', why: 'set aside' } } }))
  assert.deepEqual([...await readClaudeAutoSwitchPool(storePath)].sort(), ['app@example.com', 'in@example.com'])
})

test('a saved Codex login reports its pool membership, and the sync schema keeps it', () => {
  const usage = { plan_type: 'pro', rate_limit: null, credits: null }
  const inPool = buildSyncPayloadFromUsage(usage, 'a@example.com', { id: 'a' })
  const turnedOff = buildSyncPayloadFromUsage(usage, 'b@example.com', { id: 'b', auto_switch_enabled: false })
  assert.deepEqual(accountStateSchema.parse(inPool.accountState).account.autoSwitch, { inPool: true })
  assert.deepEqual(accountStateSchema.parse(turnedOff.accountState).account.autoSwitch, { inPool: false })
  assert.equal('autoSwitch' in buildSyncPayloadFromUsage(usage, 'c@example.com').accountState.account, false, 'no store entry: unknown')
})

const mark = (inPool: boolean) => ({ auto_switch: { in_pool: inPool, checked_at: new Date().toISOString(), machine: 'Tario-Mac' } })
const render = (metadata: unknown, provider: 'claude' | 'codex') =>
  renderToStaticMarkup(createElement(TooltipProvider, null, createElement(AutoSwitchCheck, { metadata: metadata as never, provider })))

test('a row in the pool shows the check, and hovering explains it for its provider', () => {
  const claude = render(mark(true), 'claude')
  assert.match(claude, /data-auto-switch-check/)
  assert.match(claude, /aria-label="In the auto-switch pool\. claude-auto-switch on Tario-Mac has a saved sign-in for this plan\./)
  assert.match(claude, /tabindex="0"/, 'keyboard focus opens the explanation too')
  assert.match(render(mark(true), 'codex'), /The Codex auto-switch on Tario-Mac has a saved sign-in for this plan/)
})

test('a row out of the pool, or with no mark yet, shows no check', () => {
  assert.equal(render(mark(false), 'claude'), '')
  assert.equal(render({ auth_type: 'claude' }, 'claude'), '')
  assert.equal(render(null, 'codex'), '')
  assert.equal(readAutoSwitchMark({ auto_switch: { in_pool: 'yes' } }), null, 'a malformed mark is no mark')
})

test('the explanation names when it was checked', () => {
  const text = autoSwitchExplanation('codex', { inPool: true, checkedAt: new Date().toISOString(), machine: null })
  assert.match(text, /on your Mac/)
  assert.match(text, /Checked just now\.$/)
})
