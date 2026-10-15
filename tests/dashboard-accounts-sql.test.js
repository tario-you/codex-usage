import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const available = spawnSync('initdb', ['--version']).status === 0
// security_invoker is PostgreSQL 15's; a local 14 reads the same view without it.
const migration = (name) => readFileSync(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8').replace('with (security_invoker = true)', '')

test('the dashboard view reads each account its newest reading without walking every stored one', { skip: !available && 'PostgreSQL binaries required' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'dashboard-accounts-'))
  const data = join(root, 'data')
  let started = false
  const run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  try {
    run('initdb', ['-D', data, '-A', 'trust', '--no-locale'])
    run('pg_ctl', ['-D', data, '-l', join(root, 'postgres.log'), '-o', `-k ${root} -c listen_addresses=''`, '-w', 'start'])
    started = true
    const sql = (input) => execFileSync('psql', ['-h', root, '-d', 'postgres', '-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1'], { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
    sql(`
      create role authenticated;
      create schema auth;
      create function auth.uid() returns uuid language sql stable as $$ select '11111111-1111-4111-8111-111111111111'::uuid $$;
      create table codex_accounts (id integer primary key, owner_user_id uuid, account_key text, email text, display_name text,
        plan_type text, source_key text, source_label text, codex_home text, metadata jsonb, last_seen_at timestamptz,
        last_snapshot_at timestamptz, plan_started_at timestamptz, plan_ends_at timestamptz);
      create table codex_usage_snapshots (id integer primary key, account_id integer, source_key text, fetched_at timestamptz,
        primary_used_percent integer, primary_window_mins integer, primary_resets_at timestamptz,
        secondary_used_percent integer, secondary_window_mins integer, secondary_resets_at timestamptz,
        credits_balance numeric, has_credits boolean, unlimited_credits boolean, raw_rate_limits jsonb, raw_rate_limits_by_limit_id jsonb);
      create index codex_usage_snapshots_account_fetch_idx on codex_usage_snapshots (account_id, fetched_at desc, id desc);
      create table codex_usage_percentage_overrides (account_id integer, window_key text, source_snapshot_id integer, remaining_percent integer);
      insert into codex_accounts (id, owner_user_id, account_key, email) values
        (1, '11111111-1111-4111-8111-111111111111', 'claude:one', 'one'),
        (2, '22222222-2222-4222-8222-222222222222', 'chatgpt:two', 'two'),
        (3, '11111111-1111-4111-8111-111111111111', 'claude:none', 'none');
      insert into codex_usage_snapshots (id, account_id, fetched_at, primary_used_percent, secondary_used_percent) values
        (1, 1, '2026-10-15 01:00+00', 10, 10), (2, 1, '2026-10-15 03:00+00', 30, 30),
        (3, 1, '2026-10-15 02:00+00', 20, 20), (4, 2, '2026-10-15 03:00+00', 40, 40),
        (5, 2, '2026-10-15 03:00+00', 50, 50);
      insert into codex_usage_percentage_overrides values (2, 'secondary', 5, 90), (1, 'secondary', 1, 5);
    `)
    const rows = () => sql(`select string_agg(concat_ws(':', id, access_scope, snapshot_id, primary_used_percent, secondary_used_percent, secondary_remaining_overridden), ',' order by id) from codex_dashboard_accounts;`)
    sql(migration('20261010070000_plan_ends_at.sql'))
    const before = rows()
    sql(migration('20261015060000_dashboard_accounts_newest_reading.sql'))
    // Newest by time, ties broken by the higher id, an override only on the reading it was made against, no reading kept.
    assert.equal(rows(), '1:owned:2:30:30:f,2:shared:5:50:10:t,3:owned:f')
    assert.equal(rows(), before, 'the same rows as the view it replaces')
    sql('set enable_seqscan = off;')
    const plan = sql('explain select * from codex_dashboard_accounts;')
    assert.doesNotMatch(plan, /Unique/, 'no DISTINCT ON over every stored reading')
    assert.match(plan, /Limit[\s\S]*codex_usage_snapshots_account_fetch_idx/, 'one indexed lookup per account')
  } finally {
    if (started) spawnSync('pg_ctl', ['-D', data, '-m', 'immediate', 'stop'])
    rmSync(root, { recursive: true, force: true })
  }
})
