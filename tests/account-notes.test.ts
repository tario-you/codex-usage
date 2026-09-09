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
  const aad = accountNoteAssociatedData('owner-1', 'me@example.com')
  const encrypted = encryptSharedLogin(serializeAccountNote(fields), aad, KEY)
  assert.ok(!encrypted.ciphertext.includes('pw-one'))
  assert.deepEqual(parseAccountNote(decryptSharedLogin(encrypted.ciphertext, aad, encrypted.keyVersion, KEY)), fields)
  assert.throws(() =>
    decryptSharedLogin(encrypted.ciphertext, accountNoteAssociatedData('owner-2', 'me@example.com'), encrypted.keyVersion, KEY),
  )
})

test('the input schema lowercases and trims the email and bounds the fields', () => {
  const parsed = accountNoteInputSchema.parse({ email: '  Me@Example.COM ', chatgptPassword: 'x' })
  assert.equal(parsed.email, 'me@example.com')
  assert.ok(!accountNoteInputSchema.safeParse({ email: 'nope' }).success)
  assert.ok(!accountNoteInputSchema.safeParse({ email: 'a@b.co', googlePassword: 'x'.repeat(513) }).success)
})

test('blank fields normalize to null and an all-blank note counts as empty', () => {
  const fields = normalizeAccountNoteFields({ chatgptPassword: '  ', googlePassword: null, note: ' keep ' })
  assert.deepEqual(fields, { chatgptPassword: null, googlePassword: null, note: 'keep' })
  assert.equal(isEmptyAccountNote(fields), false)
  assert.equal(isEmptyAccountNote(normalizeAccountNoteFields({})), true)
  assert.deepEqual(parseAccountNote('{"v":1,"chatgptPassword":7}'), { chatgptPassword: null, googlePassword: null, note: null })
})
