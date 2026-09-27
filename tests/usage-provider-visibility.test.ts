import assert from 'node:assert/strict'
import test from 'node:test'
import { filterUsageAccounts, readUsageVisibility, saveUsageVisibility } from '../src/features/dashboard/usage-provider-visibility'

test('provider selection keeps only matching accounts, including same-email accounts on different providers', () => {
  const accounts = [
    { account_key: 'codex-account', email: 'same@example.test' },
    { account_key: 'claude:same@example.test', email: 'same@example.test' },
    { account_key: 'another-codex-account', email: 'other@example.test' },
  ]
  assert.deepEqual(filterUsageAccounts(accounts, { codex: true, claude: false }), [accounts[0], accounts[2]])
  assert.deepEqual(filterUsageAccounts(accounts, { codex: false, claude: true }), [accounts[1]])
  assert.deepEqual(filterUsageAccounts(accounts, { codex: true, claude: true }), accounts)
  assert.deepEqual(filterUsageAccounts(accounts, { codex: false, claude: false }), [])
  assert.equal(accounts.length, 3, 'filtering preserves the original account data')
})

test('all four choices are saved in durable browser storage and restored by a fresh read', () => {
  const original = globalThis.localStorage
  const values = new Map<string, string>()
  try {
    globalThis.localStorage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value) },
    } as Storage
    assert.deepEqual(readUsageVisibility(), { codex: true, claude: false })
    for (const codex of [false, true]) {
      for (const claude of [false, true]) {
        const choice = { codex, claude }
        saveUsageVisibility(choice)
        assert.deepEqual(readUsageVisibility(), choice)
      }
    }
    assert.equal(values.size, 1, 'only the provider preference is stored')
  } finally {
    if (original === undefined) delete (globalThis as { localStorage?: Storage }).localStorage
    else globalThis.localStorage = original
  }
})

test('invalid or unavailable storage uses the existing Codex-only default without breaking the page', () => {
  const original = globalThis.localStorage
  try {
    for (const value of ['invalid JSON', '{}', '{"codex":"false","claude":true}', 'null']) {
      globalThis.localStorage = { getItem: () => value } as unknown as Storage
      assert.deepEqual(readUsageVisibility(), { codex: true, claude: false })
    }
    globalThis.localStorage = {
      getItem() { throw new Error('blocked') },
      setItem() { throw new Error('blocked') },
    } as unknown as Storage
    assert.deepEqual(readUsageVisibility(), { codex: true, claude: false })
    assert.doesNotThrow(() => saveUsageVisibility({ codex: false, claude: true }))
  } finally {
    if (original === undefined) delete (globalThis as { localStorage?: Storage }).localStorage
    else globalThis.localStorage = original
  }
})
