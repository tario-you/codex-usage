import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const available = spawnSync('initdb', ['--version']).status === 0

test('browser request schema preserves owner data, blocks direct clients, and allows only one queued click per device', { skip: !available && 'PostgreSQL binaries required' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'browser-schema-'))
  const data = join(root, 'data')
  let started = false
  const run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  try {
    run('initdb', ['-D', data, '-A', 'trust', '--no-locale'])
    run('pg_ctl', ['-D', data, '-l', join(root, 'postgres.log'), '-o', `-k ${root} -c listen_addresses=''`, '-w', 'start'])
    started = true
    const sql = input => execFileSync('psql', ['-h', root, '-d', 'postgres', '-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1'], { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
    sql(`create role anon; create role authenticated; create role service_role; create schema auth;
      create table auth.users(id uuid primary key);
      create table codex_devices(id uuid primary key, metadata jsonb);
      create table codex_accounts(id uuid primary key);
      insert into auth.users values ('11111111-1111-4111-8111-111111111111');
      insert into codex_devices values ('22222222-2222-4222-8222-222222222222','{"preserve":true}');
      insert into codex_accounts values ('33333333-3333-4333-8333-333333333333');`)
    sql(readFileSync(new URL('../supabase/migrations/20260920140000_account_browser_sessions.sql', import.meta.url), 'utf8'))
    assert.equal(sql("select metadata->>'preserve' from codex_devices;"), 'true')
    assert.equal(sql("select has_table_privilege('authenticated','codex_browser_launches','INSERT'),has_table_privilege('anon','codex_browser_launches','SELECT'),relrowsecurity from pg_class where relname='codex_browser_launches';"), 'f|f|t')
    const insert = "insert into codex_browser_launches(owner_user_id,device_id,account_id,provider,email) values ('11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','33333333-3333-4333-8333-333333333333','codex','fixture@example.com');"
    sql(insert)
    assert.throws(() => sql(insert), /duplicate key/)
    assert.equal(sql("select extract(epoch from expires_at-created_at)::integer from codex_browser_launches;"), '90')
    sql("update codex_browser_launches set state='opening' where state='queued';")
    sql(insert)
    assert.equal(sql('select count(*) from codex_browser_launches;'), '2')
  } finally {
    if (started) run('pg_ctl', ['-D', data, '-m', 'fast', '-w', 'stop'])
    rmSync(root, { recursive: true, force: true })
  }
})
