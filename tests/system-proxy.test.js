import assert from 'node:assert/strict'
import test from 'node:test'

import { followSystemProxy, parseScutilProxy, routeChange } from '../bin/lib/system-proxy.js'
import { isSyncStopped } from '../src/shared/codex.ts'

// `scutil --proxy` while a VPN's local proxy is the Mac's system proxy (her-team#12378).
const ABROAD = `<dictionary> {
  ExceptionsList : <array> {
    0 : 127.0.0.1
    1 : 192.168.0.0/16
    2 : *.local
  }
  HTTPEnable : 1
  HTTPPort : 3213
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 3213
  HTTPSProxy : 127.0.0.1
  ProxyAutoConfigEnable : 0
}`
const HOME = `<dictionary> {
  HTTPEnable : 0
  HTTPSEnable : 0
}`

test('the Mac system proxy reads as an env proxy route with its exceptions', () => {
  assert.deepEqual(parseScutilProxy(ABROAD), { proxy: 'http://127.0.0.1:3213', noProxy: 'localhost,127.0.0.1,::1,.local,192.168.0.0/16' })
  assert.equal(parseScutilProxy(HOME).proxy, '')
})

test('an agent launchd started off the proxy runs again on it, and off it once it is gone', () => {
  const abroad = parseScutilProxy(ABROAD)
  const home = parseScutilProxy(HOME)
  const onProxy = routeChange({ PATH: '/bin' }, abroad)
  assert.equal(onProxy.HTTPS_PROXY, 'http://127.0.0.1:3213')
  assert.equal(onProxy.NODE_USE_ENV_PROXY, '1')
  assert.equal(onProxy.PATH, '/bin')
  assert.equal(routeChange(onProxy, abroad), null, 'already on the route')
  const back = routeChange(onProxy, home)
  assert.equal(back.HTTPS_PROXY, undefined)
  assert.equal(back.NODE_USE_ENV_PROXY, undefined)
  assert.equal(routeChange(back, home), null)
  assert.equal(routeChange({ PATH: '/bin' }, home), null, 'no proxy, never a proxy: nothing to do')
  assert.equal(routeChange({ PATH: '/bin' }, null), null, 'no route to read (not a Mac)')
})

test('a proxy the caller set is kept; the same one as the Mac adopts it in place', () => {
  const abroad = parseScutilProxy(ABROAD)
  assert.equal(routeChange({ HTTPS_PROXY: 'http://corp:8080', NODE_USE_ENV_PROXY: '1' }, abroad), null)
  const launchd = { HTTPS_PROXY: 'http://127.0.0.1:3213', NODE_USE_ENV_PROXY: '1' }
  assert.equal(routeChange(launchd, abroad), null)
  assert.ok(routeChange(launchd, parseScutilProxy(HOME)), 'adopted, so the proxy going away is followed')
})

test('a route change stops what the process holds, then re-runs it in place', async () => {
  const calls = []
  const env = { PATH: '/bin' }
  const ran = await followSystemProxy({ env, route: parseScutilProxy(ABROAD), before: async () => calls.push('before'), execve: (file, args, next) => calls.push(['execve', file === process.execPath, args[0] === process.execPath, next.NODE_USE_ENV_PROXY]) })
  assert.equal(ran, true)
  assert.deepEqual(calls, ['before', ['execve', true, true, '1']])
  assert.equal(await followSystemProxy({ env, route: parseScutilProxy(HOME), execve: () => assert.fail('no change') }), false)
})

test('a sync quiet for over an hour shows as stopped (her-team#12378)', () => {
  const ago = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString()
  assert.equal(isSyncStopped(ago(5), 8), false)
  assert.equal(isSyncStopped(ago(61), 8), true)
  assert.equal(isSyncStopped(ago(29 * 60), 8), true)
  assert.equal(isSyncStopped(null, 8), true)
  assert.equal(isSyncStopped(null, 0), false, 'no accounts yet is not a stopped sync')
})
