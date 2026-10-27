import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { dropUncountedPlans, type HistoryPoint, type PlanReading } from '../src/lib/uncounted-history'

type DashboardWeeklyUsageHistoryPoint = HistoryPoint & { provider: string }

const available = spawnSync('initdb', ['--version']).status === 0

// her-team#15046: the chart's total counts the plans the rows count. The client takes the uncounted plans out of
// the live history SQL's sums; this holds that equal to the same SQL run over the counted plans alone.
test('taking the uncounted plans out of the history equals the history of the counted plans alone', { skip: !available && 'PostgreSQL binaries required' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'uncounted-history-'))
  const data = join(root, 'data')
  let started = false
  const run = (cmd: string, args: string[]) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  try {
    run('initdb', ['-D', data, '-A', 'trust', '--no-locale'])
    run('pg_ctl', ['-D', data, '-l', join(root, 'postgres.log'), '-o', `-k ${root} -c listen_addresses=''`, '-w', 'start'])
    started = true
    const sql = (input: string) => execFileSync('psql', ['-h', root, '-d', 'postgres', '-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1'], { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
    sql(`
      create role authenticated;
      create table codex_accounts (id integer primary key, owner_user_id text, account_key text, plan_type text);
      create table codex_usage_snapshots (id integer primary key, account_id integer, fetched_at timestamptz,
        primary_used_percent integer, primary_window_mins integer, secondary_used_percent integer, secondary_window_mins integer,
        raw_rate_limits jsonb not null default '{}'::jsonb);
      create function user_can_access_codex_owner(candidate_owner_user_id text) returns boolean
        language sql stable as $$ select candidate_owner_user_id = 'allowed' $$;
      insert into codex_accounts values (1, 'allowed', 'claude:one', 'max'), (2, 'allowed', 'claude:dead', 'max'),
        (3, 'allowed', 'claude:aside', 'max'), (4, 'allowed', 'codex:pro', 'pro'), (5, 'allowed', 'codex:lite', 'prolite'),
        (6, 'allowed', 'claude:never-read', 'max');
      insert into codex_usage_snapshots(id, account_id, fetched_at, primary_used_percent, primary_window_mins, secondary_used_percent, secondary_window_mins, raw_rate_limits) values
        (1, 1, now() - interval '100 minutes', 10, 300, 30, 10080, '{}'),
        (2, 1, now() - interval '20 minutes', 100, 300, 50, 10080, '{}'),
        (3, 2, now() - interval '3 hours', 0, 300, 0, 10080, '{}'),
        (4, 3, now() - interval '70 minutes', 0, 300, 20, 10080, '{}'),
        (5, 3, now() - interval '40 minutes', 100, 300, 40, 10080, '{}'),
        (6, 3, now() - interval '5 minutes', 0, 300, 60, 10080, '{}'),
        (7, 4, now() - interval '90 minutes', 0, 300, 10, 10080, '{}'),
        (8, 5, now() - interval '50 minutes', null, null, 20, 10080, '{"planType":" ProLite "}'),
        (9, 5, now() - interval '10 minutes', null, null, 60, 10080, '{}'),
        (10, 4, now() - interval '30 minutes', 100, 300, 70, 10080, '{}');
    `)
    sql(readFileSync(new URL('../supabase/migrations/20261016110000_usage_history_effective_room.sql', import.meta.url), 'utf8'))
    const history = (provider: string): DashboardWeeklyUsageHistoryPoint[] =>
      JSON.parse(sql(`select coalesce(json_agg(r order by r."fetchedAt"), '[]') from (select fetched_at as "fetchedAt", account_count as "accountCount",
        total_remaining_percent::float8 as "totalRemainingPercent", total_capacity_percent::float8 as "totalCapacityPercent",
        effective_remaining_percent::float8 as "effectiveRemainingPercent", '${provider}' as provider
        from list_dashboard_usage_history(now() - interval '2 hours', '${provider}', 300)) r;`))
    const readings = (ids: number[]): PlanReading[] =>
      JSON.parse(sql(`select coalesce(json_agg(r), '[]') from (select id, account_id::text, fetched_at, primary_used_percent, primary_window_mins,
        secondary_used_percent, secondary_window_mins, raw_rate_limits->>'planType' as plan_type
        from codex_usage_snapshots where account_id in (${ids.join(',')})) r;`))

    const claude = history('claude')
    const codex = history('codex')
    const uncountedClaude = [
      { id: '2', account_key: 'claude:dead', plan_type: 'max' },
      { id: '3', account_key: 'claude:aside', plan_type: 'max' },
      { id: '6', account_key: 'claude:never-read', plan_type: 'max' },
    ]
    const uncountedCodex = [{ id: '5', account_key: 'codex:lite', plan_type: 'prolite' }]
    const ours = [
      ...dropUncountedPlans(claude, 'claude', uncountedClaude, readings([2, 3, 6])),
      ...dropUncountedPlans(codex, 'codex', uncountedCodex, readings([5])),
    ]

    sql('delete from codex_usage_snapshots where account_id in (2, 3, 5, 6); delete from codex_accounts where id in (2, 3, 5, 6);')
    // The newest bucket is clipped to now(), which moves between the two reads; the whole buckets compare.
    const counted = [...history('claude'), ...history('codex')].filter((point) => Date.parse(point.fetchedAt) % 300_000 === 0)
    assert.ok(counted.length >= 4, 'the counted plans alone draw points to compare')
    for (const expected of counted) {
      const point = ours.find((candidate) => candidate.provider === expected.provider && Date.parse(candidate.fetchedAt) === Date.parse(expected.fetchedAt))
      assert.ok(point, `a ${expected.provider} point at ${expected.fetchedAt}`)
      assert.deepEqual(
        { count: point.accountCount, room: point.totalRemainingPercent, capacity: point.totalCapacityPercent, effective: point.effectiveRemainingPercent },
        { count: expected.accountCount, room: expected.totalRemainingPercent, capacity: expected.totalCapacityPercent, effective: expected.effectiveRemainingPercent },
        `${expected.provider} at ${expected.fetchedAt}`)
    }
    const before = claude.at(-1)!
    const after = ours.filter((point) => point.provider === 'claude').at(-1)!
    assert.ok(before.totalRemainingPercent > after.totalRemainingPercent, 'the dead plan\'s old 100% and the set-aside plan\'s room leave the total')
  } finally {
    if (started) run('pg_ctl', ['-D', data, '-m', 'fast', '-w', 'stop'])
    rmSync(root, { recursive: true, force: true })
  }
})

test('a point with no counted plan left is dropped; a plan with no plans to drop is untouched', () => {
  const points: DashboardWeeklyUsageHistoryPoint[] = [
    { provider: 'claude', accountCount: 1, fetchedAt: '2026-10-27T04:00:00.000Z', totalCapacityPercent: 100, totalRemainingPercent: 80, effectiveRemainingPercent: 80 },
  ]
  const reading: PlanReading = { id: 1, account_id: 'a', fetched_at: '2026-10-27T03:00:00+00:00', primary_used_percent: 20, primary_window_mins: 10080, secondary_used_percent: null, secondary_window_mins: null, plan_type: null }
  assert.deepEqual(dropUncountedPlans(points, 'claude', [{ id: 'a', account_key: 'claude:a', plan_type: null }], [reading]), [])
  assert.equal(dropUncountedPlans(points, 'claude', [], []), points)
})
