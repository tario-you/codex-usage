import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { AccountBrowserLink } from '../src/features/dashboard/account-browser-link'

test('owned email is a provider-specific browser control on either provider', () => {
  for (const [account_key, provider] of [['codex:fixture', 'ChatGPT'], ['claude:fixture', 'Claude']]) {
    const html = renderToStaticMarkup(createElement(AccountBrowserLink, {
      account: { account_key, email: 'fixture@example.com', access_scope: 'owned' }, session: {}, children: 'fixture@example.com',
    }))
    assert.match(html, new RegExp(`aria-label="Open ${provider} as fixture@example.com"`))
    assert.match(html, /Sign in once on first use/)
    assert.match(html, /<button/)
  }
})

test('shared accounts and unidentified rows cannot launch another owner browser session', () => {
  for (const account of [
    { email: 'fixture@example.com', access_scope: 'shared' },
    { email: null, access_scope: 'owned' },
  ]) {
    const html = renderToStaticMarkup(createElement(AccountBrowserLink, { account, session: {}, children: 'fixture' }))
    assert.doesNotMatch(html, /<button/)
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
  }
})
