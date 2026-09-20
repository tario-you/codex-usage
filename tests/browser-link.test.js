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
