import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { AccountBrowserLink } from '../src/features/dashboard/account-browser-link'
import { browserLoginUrl } from '../src/features/dashboard/browser-login-url'
import { readBrowserSessionMode, setBrowserSessionMode } from '../src/features/dashboard/browser-session-mode'

test('owned email is a provider-specific browser control on either provider', () => {
  for (const [account_key, provider] of [['codex:fixture', 'ChatGPT'], ['claude:fixture', 'Claude']]) {
    const html = renderToStaticMarkup(createElement(AccountBrowserLink, {
      account: { account_key, email: 'fixture@example.com', access_scope: 'owned' }, session: {}, children: 'fixture@example.com',
    }))
    assert.match(html, new RegExp(`aria-label="Open ${provider} sign-in for fixture@example.com"`))
    assert.match(html, /in this browser profile/)
    assert.match(html, /<a href="https:\/\/(chatgpt.com|claude.ai)\//)
    assert.match(html, /target="_blank" rel="noopener noreferrer"/)
    assert.doesNotMatch(html, /<button/)
  }
})

test('shared accounts and unidentified rows cannot launch another owner browser session', () => {
  for (const account of [
    { email: 'fixture@example.com', access_scope: 'shared' },
    { email: null, access_scope: 'owned' },
  ]) {
    const html = renderToStaticMarkup(createElement(AccountBrowserLink, { account, session: {}, children: 'fixture' }))
    assert.doesNotMatch(html, /<button|<a /)
  }
})


test('saved Google credentials suggest Google, but an explicit account choice wins', async () => {
  const { resolveBrowserLoginMethod } = await import('../src/features/dashboard/browser-login-method.ts')
  assert.equal(resolveBrowserLoginMethod(null, true), 'google')
  assert.equal(resolveBrowserLoginMethod(null, false), 'email')
  assert.equal(resolveBrowserLoginMethod('email', true), 'email')
  assert.equal(resolveBrowserLoginMethod('google', false), 'google')
  assert.equal(resolveBrowserLoginMethod('invalid', true), 'google')
  for (const hasGoogleCredential of [true, false]) {
    const html = renderToStaticMarkup(createElement(AccountBrowserLink, {
      account: { id: 'fixture', account_key: 'codex:fixture', email: 'fixture@example.com', access_scope: 'owned' },
      session: {}, children: 'fixture@example.com', hasGoogleCredential,
    }))
    assert.match(html, /Sign-in method for ChatGPT fixture@example.com/)
    assert.match(html, new RegExp('value="' + (hasGoogleCredential ? 'google' : 'email') + '" selected=""'))
    assert.equal(html.includes('connection=google-oauth2'), hasGoogleCredential)
  }
})

test('login links preserve encoded email hints and only request Google on ChatGPT', () => {
  for (const provider of ['codex', 'claude']) {
    for (const method of ['email', 'google']) {
      const url = new URL(browserLoginUrl(provider, ' Fixture+work@Example.com ', method))
      assert.equal(url.origin, provider === 'codex' ? 'https://chatgpt.com' : 'https://claude.ai')
      assert.equal(url.searchParams.get(provider === 'codex' ? 'login_hint' : 'email'), 'fixture+work@example.com')
      assert.equal(url.searchParams.get('connection'), provider === 'codex' && method === 'google' ? 'google-oauth2' : null)
      if (provider === 'codex') assert.equal(url.searchParams.get('callback_path'), '/')
    }
  }
})

test('browser choice defaults to current, remembers separate profiles per owner, and notifies other rows', () => {
  const values = new Map()
  const target = new EventTarget()
  let notifications = 0
  target.addEventListener('browser-session-mode-changed', () => notifications++)
  const originals = { localStorage: globalThis.localStorage, window: globalThis.window }
  globalThis.window = target
  globalThis.localStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) }
  try {
    assert.equal(readBrowserSessionMode('owner-a'), 'current')
    setBrowserSessionMode('owner-a', 'separate')
    assert.equal(readBrowserSessionMode('owner-a'), 'separate')
    assert.equal(readBrowserSessionMode('owner-b'), 'current')
    assert.equal(values.get('browser-session-mode:owner-a'), 'separate')
    setBrowserSessionMode('owner-a', 'current')
    assert.equal(readBrowserSessionMode('owner-a'), 'current')
    assert.equal(notifications, 2)
    globalThis.localStorage = { getItem() { throw Error('blocked') }, setItem() { throw Error('blocked') } }
    setBrowserSessionMode('storage-blocked', 'separate')
    assert.equal(readBrowserSessionMode('storage-blocked'), 'separate')
    assert.equal(readBrowserSessionMode('different-owner'), 'current')
    assert.equal(notifications, 3)
  } finally {
    if (originals.localStorage === undefined) delete globalThis.localStorage
    else globalThis.localStorage = originals.localStorage
    if (originals.window === undefined) delete globalThis.window
    else globalThis.window = originals.window
  }
})
