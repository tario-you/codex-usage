import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import test from 'node:test'

import {
  accountNoteAssociatedData,
  accountNoteInputSchema,
  isEmptyAccountNote,
  normalizeAccountNoteFields,
  parseAccountNote,
  serializeAccountNote,
} from '../api/_lib/account-notes'
import { decryptSharedLogin, encryptSharedLogin } from '../api/_lib/login-crypto'

const KEY = randomBytes(32)

test('a note round-trips through encryption bound to its owner and email', () => {
  const fields = { chatgptPassword: 'pw-one', googlePassword: 'pw-two', note: 'resets sep 13' }
  const aad = accountNoteAssociatedData('owner-1', 'me@example.com', 'codex')
  const encrypted = encryptSharedLogin(serializeAccountNote(fields), aad, KEY)
  assert.ok(!encrypted.ciphertext.includes('pw-one'))
  assert.deepEqual(parseAccountNote(decryptSharedLogin(encrypted.ciphertext, aad, encrypted.keyVersion, KEY)), fields)
  assert.throws(() =>
    decryptSharedLogin(encrypted.ciphertext, accountNoteAssociatedData('owner-2', 'me@example.com', 'codex'), encrypted.keyVersion, KEY),
  )
})

test('the input schema lowercases and trims the email and bounds the fields', () => {
  const parsed = accountNoteInputSchema.parse({ provider: 'codex', email: '  Me@Example.COM ', chatgptPassword: 'x' })
  assert.equal(parsed.email, 'me@example.com')
  assert.ok(!accountNoteInputSchema.safeParse({ provider: 'codex', email: 'nope' }).success)
  assert.ok(!accountNoteInputSchema.safeParse({ provider: 'codex', email: 'a@b.co', googlePassword: 'x'.repeat(513) }).success)
})

test('blank fields normalize to null and an all-blank note counts as empty', () => {
  const fields = normalizeAccountNoteFields({ chatgptPassword: '  ', googlePassword: null, note: ' keep ' })
  assert.deepEqual(fields, { chatgptPassword: null, googlePassword: null, note: 'keep' })
  assert.equal(isEmptyAccountNote(fields), false)
  assert.equal(isEmptyAccountNote(normalizeAccountNoteFields({})), true)
  assert.deepEqual(parseAccountNote('{"v":1,"chatgptPassword":7}'), { chatgptPassword: null, googlePassword: null, note: null })
})


test('provider identity separates same-email rows while normalizing email casing', async () => {
  const { accountNoteKey, noteKey } = await import('../src/features/dashboard/account-note-identity')
  const codex = { account_key: 'account-id', email: '  Same@Example.COM ' }
  const claude = { account_key: 'claude:same@example.com', email: 'same@example.com' }
  assert.notEqual(accountNoteKey(codex), accountNoteKey(claude))
  assert.equal(accountNoteKey(codex), noteKey('same@example.com', 'codex'))
  assert.equal(accountNoteKey(claude), noteKey(' SAME@example.com ', 'claude'))
  const notes = new Map([[accountNoteKey(codex), 'codex note'], [accountNoteKey(claude), 'claude note']])
  assert.equal(notes.size, 2)
  assert.equal(notes.get(accountNoteKey(codex)), 'codex note')
})

test('new ciphertext cannot move across provider, owner, or email; old ciphertext remains readable', () => {
  const plaintext = serializeAccountNote({ note: 'preserve me', chatgptPassword: null, googlePassword: null })
  const encrypted = encryptSharedLogin(plaintext, accountNoteAssociatedData('owner-1', 'same@example.com', 'codex'), KEY)
  for (const [owner, email, provider] of [
    ['owner-1', 'same@example.com', 'claude'],
    ['owner-2', 'same@example.com', 'codex'],
    ['owner-1', 'different@example.com', 'codex'],
  ] as const) {
    assert.throws(() => decryptSharedLogin(encrypted.ciphertext, accountNoteAssociatedData(owner, email, provider), encrypted.keyVersion, KEY))
  }
  const legacy = encryptSharedLogin(plaintext, 'account-note:owner-1:same@example.com', KEY)
  for (const provider of ['codex', 'claude'] as const) {
    assert.equal(decryptSharedLogin(legacy.ciphertext, accountNoteAssociatedData('owner-1', 'same@example.com', provider, 1), legacy.keyVersion, KEY), plaintext)
  }
  assert.throws(() => accountNoteAssociatedData('owner-1', 'same@example.com', 'codex', 3))
})

test('ambiguous or unknown-provider writes are rejected', () => {
  assert.equal(accountNoteInputSchema.safeParse({ email: 'same@example.com', note: 'old tab' }).success, false)
  assert.equal(accountNoteInputSchema.safeParse({ provider: 'other', email: 'same@example.com' }).success, false)
  assert.equal(accountNoteInputSchema.parse({ provider: 'claude', email: 'same@example.com' }).provider, 'claude')
})
