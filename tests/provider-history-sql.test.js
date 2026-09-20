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
    sql(`alter table codex_accounts add column plan_type text;
      alter table codex_usage_snapshots add column raw_rate_limits jsonb not null default '{}'::jsonb;
      update codex_accounts set plan_type='pro';
      insert into codex_accounts values (5,'allowed','codex:lite','prolite');
      insert into codex_usage_snapshots(id,account_id,fetched_at,secondary_used_percent,secondary_window_mins)
        values (7,5,now() - interval '1 minute',25,10080);`)
    sql(readFileSync(new URL('../supabase/migrations/20260920150000_weighted_weekly_usage_history.sql', import.meta.url), 'utf8'))
    const weighted = (provider) => JSON.parse(sql(`select row_to_json(r) from (select total_remaining_percent, account_count, total_capacity_percent from list_dashboard_weighted_weekly_usage_history(now() - interval '2 hours', '${provider}', 300) order by fetched_at desc limit 1) r;`))
    assert.deepEqual(weighted('codex'), { total_remaining_percent: 78.75, account_count: 2, total_capacity_percent: 125 }, '60 Pro + 75% of a 25-unit ProLite; retain fractional precision')
    assert.deepEqual(weighted('claude'), latest('claude'), 'Claude stays unchanged')
    sql("update codex_usage_snapshots set raw_rate_limits='{\"planType\":\"pro\"}' where id=7;")
    assert.deepEqual(weighted('codex'), { total_remaining_percent: 135, account_count: 2, total_capacity_percent: 200 }, 'snapshot plan type takes precedence over current plan label')
    sql("update codex_usage_snapshots set raw_rate_limits='{\"planType\":\" PROLITE \"}' where id=7;")
    assert.equal(weighted('codex').total_remaining_percent, 78.75)
    assert.equal(sql("select prosecdef from pg_proc where proname = 'list_dashboard_weighted_weekly_usage_history';"), 'f')
    assert.equal(sql("select has_function_privilege('authenticated', 'list_dashboard_weighted_weekly_usage_history(timestamptz,text,integer)', 'execute');"), 't')
  } finally {
    if (started) run('pg_ctl', ['-D', data, '-m', 'fast', '-w', 'stop'])
    rmSync(root, { recursive: true, force: true })
  }
})
