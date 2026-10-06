import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const available = spawnSync('initdb', ['--version']).status === 0

test('the reader functions read the dashboard as its owner, and only the server key may call them', { skip: !available && 'PostgreSQL binaries required' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'reader-sql-'))
  const data = join(root, 'data')
  let started = false
  const run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  try {
    run('initdb', ['-D', data, '-A', 'trust', '--no-locale'])
    run('pg_ctl', ['-D', data, '-l', join(root, 'postgres.log'), '-o', `-k ${root} -c listen_addresses=''`, '-w', 'start'])
    started = true
    const sql = (input) => execFileSync('psql', ['-h', root, '-d', 'postgres', '-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1'], { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
    // Supabase's own pieces, as small as the functions need: its roles, auth.uid() and the dashboard's read path.
    sql(`
      create role anon; create role authenticated; create role service_role;
      create schema auth; create table auth.users (id uuid primary key);
      create function auth.uid() returns uuid language sql stable as $$
        select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''), (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid $$;
      insert into auth.users values ('11111111-1111-4111-8111-111111111111'), ('22222222-2222-4222-8222-222222222222');
      create table codex_accounts (id integer primary key, owner_user_id uuid, account_key text);
      insert into codex_accounts values (1, '11111111-1111-4111-8111-111111111111', 'claude:mine'), (2, '22222222-2222-4222-8222-222222222222', 'claude:theirs');
      create function user_can_access_codex_owner(candidate_owner_user_id uuid) returns boolean language sql stable as $$ select candidate_owner_user_id = auth.uid() $$;
      create view codex_dashboard_accounts as select acct.id, acct.owner_user_id,
        case when acct.owner_user_id = auth.uid() then 'owned' else 'shared' end as access_scope, acct.account_key from codex_accounts acct;
      create function list_dashboard_weighted_weekly_usage_history(range_start timestamptz, usage_provider text, bucket_seconds integer default 900)
        returns table (fetched_at timestamptz, total_remaining_percent numeric, account_count integer, total_capacity_percent numeric)
        language sql stable as $$ select now(), 50::numeric, count(*)::integer, 100::numeric from codex_accounts where user_can_access_codex_owner(owner_user_id) $$;
    `)
    sql(readFileSync(new URL('../supabase/migrations/20261006040000_samantha_reader.sql', import.meta.url), 'utf8'))
    const rows = sql(`select account_key || ':' || access_scope from reader_dashboard_accounts('11111111-1111-4111-8111-111111111111');`)
    assert.equal(rows, 'claude:mine:owned', 'his rows only, owned as in his browser')
    assert.equal(sql(`select account_count from reader_weighted_weekly_usage_history('22222222-2222-4222-8222-222222222222', now() - interval '1 day', 'claude', 300);`), '1')
    const grants = (fn) => sql(`select string_agg(r, ',' order by r) from (select r from unnest(array['anon','authenticated','service_role']) r where has_function_privilege(r, '${fn}', 'execute')) x;`)
    assert.equal(grants('reader_dashboard_accounts(uuid)'), 'service_role')
    assert.equal(grants('reader_weighted_weekly_usage_history(uuid,timestamptz,text,integer)'), 'service_role')
    assert.equal(grants('reader_claims(uuid)'), '')
    assert.equal(sql(`select relrowsecurity from pg_class where relname = 'codex_readers';`), 't')
  } finally {
    if (started) spawnSync('pg_ctl', ['-D', data, '-m', 'immediate', 'stop'])
    rmSync(root, { recursive: true, force: true })
  }
})
