import assert from 'node:assert/strict'
import { existsSync, statSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  RECIPIENT_LAST_REFRESH_SHIFT_MS,
  applyAuthFileToStoreAccount,
  backupFileOnce,
  buildAuthFileFromStoreAccount,
  buildRecipientAuthFile,
  describeSharedLogin,
  fingerprintSharedLogin,
  validateSharedLoginFile,
  writeJsonFilePrivately,
} from '../bin/lib/login-file.js'
import {
  readSharedLoginConfig,
  reconcilePublishedLogins,
  restoreSharedLogin,
  syncSharedLoginOnce,
} from '../bin/lib/shared-login.js'

const ISSUED_AT = 1_700_000_000

test('a recipient copy shifts last_refresh forward so the owner refreshes first', () => {
  const file = buildAuthFile({ issuedAt: ISSUED_AT })
  const recipient = buildRecipientAuthFile(file)

  assert.equal(
    Date.parse(recipient.last_refresh) - Date.parse(file.last_refresh),
    RECIPIENT_LAST_REFRESH_SHIFT_MS,
  )
  assert.equal(recipient.auth_mode, 'chatgpt')
  assert.equal(recipient.OPENAI_API_KEY, null)
  assert.equal(fingerprintSharedLogin(recipient), fingerprintSharedLogin(file))
})

test('validation rejects API key logins and missing tokens', () => {
  assert.throws(() => validateSharedLoginFile({ ...buildAuthFile({}), OPENAI_API_KEY: 'sk' }), /API key/)
  const broken = buildAuthFile({})
  delete broken.tokens.refresh_token
  assert.throws(() => validateSharedLoginFile(broken), /refresh_token/)
})

test('switcher store entries round-trip through an auth file', () => {
  const file = buildAuthFile({ issuedAt: ISSUED_AT, salt: 'store' })
  const account = {
    auth_data: { type: 'chat_g_p_t', ...file.tokens },
    email: 'Owner@example.com',
  }

  const derived = buildAuthFileFromStoreAccount(account)
  assert.equal(derived.last_refresh, new Date(ISSUED_AT * 1000).toISOString())
  assert.equal(describeSharedLogin(derived).email, 'owner@example.com')

  const newer = buildAuthFile({ issuedAt: ISSUED_AT + 100, salt: 'newer' })
  applyAuthFileToStoreAccount(account, newer)
  assert.equal(account.auth_data.type, 'chat_g_p_t')
  assert.equal(account.auth_data.refresh_token, newer.tokens.refresh_token)
})

test('private writes use mode 600 and back up the previous file once', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'codex-usage-login-'))
  t.after(() => rm(dir, { force: true, recursive: true }))
  const filePath = path.join(dir, 'auth.json')

  await writeFile(filePath, '{"original":true}\n')
  const backupPath = await backupFileOnce(filePath)
  assert.ok(backupPath && existsSync(backupPath))

  await writeJsonFilePrivately(filePath, { replaced: true })
  assert.equal(statSync(filePath).mode & 0o777, 0o600)
  assert.equal(await backupFileOnce(filePath), backupPath)
  assert.equal(await readFile(backupPath, 'utf8'), '{"original":true}\n')
})

test('the recipient sync pulls newer generations, pushes local refreshes, and restores on revoke', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'codex-usage-login-'))
  t.after(() => rm(dir, { force: true, recursive: true }))
  const authPath = path.join(dir, 'auth.json')
  const original = buildAuthFile({ issuedAt: ISSUED_AT - 5000, salt: 'mine' })
  await writeFile(authPath, JSON.stringify(original))
  await backupFileOnce(authPath)

  const serverFile = buildAuthFile({ issuedAt: ISSUED_AT, salt: 'shared' })
  const requests = []
  let mode = 'pull'
  const server = await startJsonServer((body) => {
    requests.push(body)
    if (mode === 'revoked') {
      return { body: { error: 'This shared login was revoked.' }, status: 401 }
    }

    if (
      body.authFile &&
      Date.parse(describeSharedLogin(body.authFile).issuedAt) >
        Date.parse(describeSharedLogin(serverFile).issuedAt)
    ) {
      return {
        body: {
          fingerprint: fingerprintSharedLogin(body.authFile),
          issuedAt: describeSharedLogin(body.authFile).issuedAt,
          ok: true,
          outcome: 'stored',
        },
      }
    }

    if (body.fingerprint === fingerprintSharedLogin(serverFile)) {
      return {
        body: { fingerprint: body.fingerprint, ok: true, outcome: 'unchanged' },
      }
    }

    return {
      body: {
        authFile: serverFile,
        fingerprint: fingerprintSharedLogin(serverFile),
        issuedAt: describeSharedLogin(serverFile).issuedAt,
        ok: true,
        outcome: 'pull',
      },
    }
  })
  t.after(() => server.close())

  const previouslyInstalled = buildAuthFile({ issuedAt: ISSUED_AT - 100, salt: 'old-shared' })
  const config = {
    accessToken: 'grant-access-token',
    account: { email: 'owner@example.com', planType: 'pro' },
    backupPath: `${authPath}.before-shared-login`,
    fingerprint: fingerprintSharedLogin(previouslyInstalled),
    pollMs: 60_000,
    syncUrl: `${server.url}/api/login/sync`,
  }
  await writeJsonFilePrivately(authPath, buildRecipientAuthFile(previouslyInstalled))

  const pulled = await syncSharedLoginOnce({ codexHome: dir, config })
  assert.equal(pulled.outcome, 'pull')
  const installed = JSON.parse(await readFile(authPath, 'utf8'))
  assert.equal(installed.tokens.refresh_token, serverFile.tokens.refresh_token)
  assert.equal(
    Date.parse(installed.last_refresh) - Date.parse(serverFile.last_refresh),
    RECIPIENT_LAST_REFRESH_SHIFT_MS,
  )
  assert.equal(config.fingerprint, fingerprintSharedLogin(serverFile))
  assert.equal(requests.at(-1).authFile, undefined, 'an unchanged local file sends only its fingerprint')

  const unchanged = await syncSharedLoginOnce({ codexHome: dir, config })
  assert.equal(unchanged.outcome, 'unchanged')

  const refreshedLocally = buildAuthFile({ issuedAt: ISSUED_AT + 500, salt: 'refreshed' })
  await writeFile(authPath, JSON.stringify(refreshedLocally))
  const pushed = await syncSharedLoginOnce({ codexHome: dir, config })
  assert.equal(pushed.outcome, 'stored')
  assert.equal(requests.at(-1).authFile.tokens.refresh_token, refreshedLocally.tokens.refresh_token)
  assert.equal(config.fingerprint, fingerprintSharedLogin(refreshedLocally))

  await writeFile(authPath, JSON.stringify(buildAuthFile({ email: 'someone@else.dev', salt: 'x' })))
  const foreign = await syncSharedLoginOnce({ codexHome: dir, config })
  assert.equal(foreign.outcome, 'foreign')
  assert.equal(foreign.stopped, true)
  assert.match(JSON.parse(await readFile(authPath, 'utf8')).tokens.refresh_token, /refresh-x/)

  await writeFile(authPath, JSON.stringify(refreshedLocally))
  mode = 'revoked'
  const revoked = await syncSharedLoginOnce({ codexHome: dir, config })
  assert.equal(revoked.outcome, 'revoked')
  assert.deepEqual(JSON.parse(await readFile(authPath, 'utf8')), original)
  assert.equal(existsSync(config.backupPath), false)
  assert.equal(await readSharedLoginConfig(dir), null)
})

test('restore falls back to removing the shared login when no backup exists', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'codex-usage-login-'))
  t.after(() => rm(dir, { force: true, recursive: true }))
  const authPath = path.join(dir, 'auth.json')
  await writeFile(authPath, JSON.stringify(buildAuthFile({})))

  await restoreSharedLogin(dir, { quiet: true })
  assert.equal(existsSync(authPath), false)
})

test('the owner reconcile pulls newer generations into the switcher store', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'codex-usage-login-'))
  t.after(() => rm(dir, { force: true, recursive: true }))
  const storePath = path.join(dir, 'accounts.json')
  const current = buildAuthFile({ issuedAt: ISSUED_AT, salt: 'current' })
  await writeFile(
    storePath,
    JSON.stringify({
      accounts: [
        { auth_data: { type: 'chat_g_p_t', ...current.tokens }, email: 'owner@example.com' },
        { auth_data: { type: 'chat_g_p_t', id_token: 'x', access_token: 'y', refresh_token: 'z', account_id: 'w' }, email: 'other@example.com' },
      ],
      version: 1,
    }),
  )

  const newer = buildAuthFile({ issuedAt: ISSUED_AT + 900, salt: 'from-recipient' })
  const requests = []
  const server = await startJsonServer((body) => {
    requests.push(body)
    return {
      body: {
        authFile: newer,
        fingerprint: fingerprintSharedLogin(newer),
        issuedAt: describeSharedLogin(newer).issuedAt,
        ok: true,
        outcome: 'pull',
      },
    }
  })
  t.after(() => server.close())

  const config = {
    dashboardOrigin: server.url,
    deviceToken: 'device-token',
    publishedLogins: [
      {
        email: 'owner@example.com',
        fingerprint: fingerprintSharedLogin(current),
        source: { email: 'owner@example.com', kind: 'store', path: storePath },
      },
    ],
  }

  const changed = await reconcilePublishedLogins({ config, log: () => {} })
  assert.equal(changed, true)
  assert.equal(requests[0].deviceToken, 'device-token')
  assert.equal(requests[0].authFile, undefined, 'unchanged local source sends only a fingerprint')
  const store = JSON.parse(await readFile(storePath, 'utf8'))
  assert.equal(store.accounts[0].auth_data.refresh_token, newer.tokens.refresh_token)
  assert.equal(store.accounts[0].auth_data.type, 'chat_g_p_t')
  assert.equal(store.accounts[1].auth_data.refresh_token, 'z')
  assert.equal(config.publishedLogins[0].fingerprint, fingerprintSharedLogin(newer))
})

test('the switcher source reads the newest of auth.json and the store, and writes pulls to both', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'codex-usage-login-'))
  t.after(() => rm(dir, { force: true, recursive: true }))
  const storePath = path.join(dir, 'accounts.json')
  const authPath = path.join(dir, 'auth.json')
  const storeGeneration = buildAuthFile({ issuedAt: ISSUED_AT, salt: 'store' })
  const activeGeneration = buildAuthFile({ issuedAt: ISSUED_AT + 300, salt: 'active' })
  await writeFile(storePath, JSON.stringify({ accounts: [{ auth_data: { type: 'chat_g_p_t', ...storeGeneration.tokens }, email: 'owner@example.com' }] }))
  await writeFile(authPath, JSON.stringify(activeGeneration))

  const pulledGeneration = buildAuthFile({ issuedAt: ISSUED_AT + 900, salt: 'pulled' })
  const requests = []
  const server = await startJsonServer((body) => {
    requests.push(body)
    return {
      body: {
        authFile: pulledGeneration,
        fingerprint: fingerprintSharedLogin(pulledGeneration),
        issuedAt: describeSharedLogin(pulledGeneration).issuedAt,
        ok: true,
        outcome: 'pull',
      },
    }
  })
  t.after(() => server.close())

  const config = {
    dashboardOrigin: server.url,
    deviceToken: 'device-token',
    publishedLogins: [
      {
        email: 'owner@example.com',
        fingerprint: 'stale',
        source: { codexHome: dir, email: 'owner@example.com', kind: 'switcher', path: storePath },
      },
    ],
  }

  await reconcilePublishedLogins({ config, log: () => {} })
  assert.equal(
    requests[0].authFile.tokens.refresh_token,
    activeGeneration.tokens.refresh_token,
    'the newer active login is what gets offered to the dashboard',
  )
  const store = JSON.parse(await readFile(storePath, 'utf8'))
  assert.equal(store.accounts[0].auth_data.refresh_token, pulledGeneration.tokens.refresh_token)
  const active = JSON.parse(await readFile(authPath, 'utf8'))
  assert.equal(active.tokens.refresh_token, pulledGeneration.tokens.refresh_token)
  assert.equal(active.last_refresh, pulledGeneration.last_refresh)
})

function buildAuthFile({ email = 'Owner@example.com', issuedAt = ISSUED_AT, salt = '' }) {
  return {
    OPENAI_API_KEY: null,
    auth_mode: 'chatgpt',
    last_refresh: new Date(issuedAt * 1000).toISOString(),
    tokens: {
      access_token: encodeJwt({
        'https://api.openai.com/auth': {
          chatgpt_account_id: 'acct-123',
          chatgpt_plan_type: 'pro',
        },
        'https://api.openai.com/profile': { email },
        exp: issuedAt + 864_000,
        iat: issuedAt,
        salt,
      }),
      account_id: 'acct-123',
      id_token: encodeJwt({ email, iat: issuedAt }),
      refresh_token: `refresh-${salt}`,
    },
  }
}

function encodeJwt(payload) {
  const segment = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${segment({ alg: 'none' })}.${segment(payload)}.sig`
}

function startJsonServer(handler) {
  return new Promise((resolve) => {
    const server = createServer((request, response) => {
      let raw = ''
      request.on('data', (chunk) => {
        raw += chunk
      })
      request.on('end', () => {
        const result = handler(raw ? JSON.parse(raw) : {}, request)
        response.writeHead(result.status ?? 200, { 'content-type': 'application/json' })
        response.end(JSON.stringify(result.body))
      })
    })

    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve({
        close: () => server.close(),
        url: `http://127.0.0.1:${address.port}`,
      })
    })
  })
}
