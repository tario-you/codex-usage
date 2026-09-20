import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const available = spawnSync('initdb', ['--version']).status === 0

test('provider history SQL separates real balances and preserves owner access and weekly-window rules', { skip: !available && 'PostgreSQL binaries required' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'provider-history-'))
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
      create table codex_accounts (id integer primary key, owner_user_id text, account_key text);
      create table codex_usage_snapshots (id integer primary key, account_id integer, fetched_at timestamptz,
        primary_used_percent integer, primary_window_mins integer, secondary_used_percent integer, secondary_window_mins integer);
      create function user_can_access_codex_owner(candidate_owner_user_id text) returns boolean
        language sql stable as $$ select candidate_owner_user_id = 'allowed' $$;
      insert into codex_accounts values (1, 'allowed', 'codex:one'), (2, 'allowed', 'claude:two'),
        (3, 'denied', 'codex:hidden'), (4, 'allowed', 'claude:four');
      insert into codex_usage_snapshots values
        (1, 1, now() - interval '1 hour', 0, 300, 20, 10080),
        (2, 2, now() - interval '1 hour', 70, 10080, null, null),
        (3, 3, now() - interval '1 hour', null, null, 0, 10080),
        (4, 4, now() - interval '1 hour', 0, 300, null, null),
        (5, 1, now() - interval '1 minute', 0, 300, 40, 10080),
        (6, 2, now() - interval '1 minute', 80, 10080, null, null);
    `)
    sql(readFileSync(new URL('../supabase/migrations/20260920130000_provider_weekly_usage_history.sql', import.meta.url), 'utf8'))
    const latest = (provider) => JSON.parse(sql(`select row_to_json(r) from (select total_remaining_percent, account_count, total_capacity_percent from list_dashboard_provider_weekly_usage_history(now() - interval '2 hours', '${provider}', 300) order by fetched_at desc limit 1) r;`))
    assert.deepEqual(latest('codex'), { total_remaining_percent: 60, account_count: 1, total_capacity_percent: 100 })
    assert.deepEqual(latest('claude'), { total_remaining_percent: 20, account_count: 2, total_capacity_percent: 200 })
    assert.equal(sql("select count(*) from list_dashboard_provider_weekly_usage_history(now() - interval '2 hours', 'invalid', 300);"), '0')
    assert.equal(sql("select prosecdef from pg_proc where proname = 'list_dashboard_provider_weekly_usage_history';"), 'f', 'security invoker retained')
    assert.equal(sql("select has_function_privilege('authenticated', 'list_dashboard_provider_weekly_usage_history(timestamptz,text,integer)', 'execute');"), 't')
  } finally {
    if (started) run('pg_ctl', ['-D', data, '-m', 'fast', '-w', 'stop'])
    rmSync(root, { recursive: true, force: true })
  }
})
