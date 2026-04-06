import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, RefreshCcw } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  buildSummary,
  dashboardAccountsQueryOptions,
  getModelBuckets,
  type DashboardAccountRow,
  type DashboardSummary,
} from '@/lib/dashboard'
import {
  formatRelativeTimestamp,
  formatTimestamp,
  formatWindowLabel,
  isFreshTimestamp,
} from '@/shared/codex'

export function DashboardPage() {
  const accountsQuery = useQuery(dashboardAccountsQueryOptions)
  const accounts = accountsQuery.data ?? []
  const summary = buildSummary(accounts)
  const isLoading = accountsQuery.isPending && accounts.length === 0
  const showEmpty = !isLoading && !accountsQuery.error && accounts.length === 0

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="mx-auto flex min-h-screen w-full max-w-[1380px] flex-col">
        <header className="border-b border-border bg-background">
          <div className="flex flex-col gap-4 px-4 py-5 sm:px-6 lg:flex-row lg:items-end lg:justify-between lg:px-8">
            <div className="space-y-1">
              <h1 className="text-[1.75rem] font-semibold tracking-[-0.02em]">
                Codex usage
              </h1>
              <p className="max-w-3xl text-sm leading-6 text-muted-foreground">
                Latest account snapshots stored in Supabase. Older accounts stay
                visible after account switches so you can compare every tracked
                home in one place.
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <div className="min-w-[180px] text-left text-sm sm:text-right">
                <p className="font-medium text-foreground">
                  {summary.mostRecentSync
                    ? `Latest sync ${formatRelativeTimestamp(summary.mostRecentSync)}`
                    : 'No snapshots yet'}
                </p>
                <p className="text-muted-foreground">
                  {formatTimestamp(summary.mostRecentSync)}
                </p>
              </div>

              <Button
                variant="outline"
                className="h-9 rounded-md border-border bg-card px-3 shadow-none transition-colors active:translate-y-0"
                onClick={() => void accountsQuery.refetch()}
              >
                <RefreshCcw className="mr-2 size-4" />
                Refresh
              </Button>
            </div>
          </div>
        </header>

        <div className="grid flex-1 gap-6 px-4 py-6 sm:px-6 lg:grid-cols-[minmax(0,1fr)_320px] lg:px-8">
          <div className="space-y-6">
            <section className="overflow-hidden rounded-lg border border-border bg-card">
              <div className="border-b border-border px-4 py-3 sm:px-5">
                <div className="flex flex-col gap-2 lg:flex-row lg:items-end lg:justify-between">
                  <div>
                    <h2 className="text-base font-semibold">Accounts</h2>
                    <p className="mt-1 max-w-3xl text-sm leading-6 text-muted-foreground">
                      Ordered by latest snapshot. Details below show quota windows
                      and any model-specific buckets captured from
                      `rateLimitsByLimitId`.
                    </p>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    Refetches every 30 seconds
                  </p>
                </div>
              </div>

              {accountsQuery.error ? (
                <ErrorBanner message={accountsQuery.error.message} />
              ) : null}

              {isLoading ? <LoadingState /> : null}
              {showEmpty ? <EmptyState /> : null}

              {accounts.length > 0 ? (
                <>
                  <div className="md:hidden">
                    <AccountSummaryList accounts={accounts} />
                  </div>
                  <div className="hidden md:block">
                    <AccountTable accounts={accounts} />
                  </div>
                  <div className="border-t border-border">
                    {accounts.map((account) => (
                      <AccountSection key={account.id} account={account} />
                    ))}
                  </div>
                </>
              ) : null}
            </section>
          </div>

          <aside className="space-y-6">
            <OverviewPanel summary={summary} />
            <CollectorPanel />
            <FilesPanel />
          </aside>
        </div>
      </div>
    </main>
  )
}

function OverviewPanel({ summary }: { summary: DashboardSummary }) {
  const freshAccounts = Math.max(0, summary.accountsTracked - summary.staleAccounts)

  return (
    <section className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="border-b border-border px-4 py-3">
        <h2 className="text-base font-semibold">Overview</h2>
      </div>
      <dl className="divide-y divide-border">
        <OverviewRow
          label="Accounts tracked"
          value={String(summary.accountsTracked)}
          note="Any account that has written a snapshot stays listed."
        />
        <OverviewRow
          label="Fresh now"
          value={String(freshAccounts)}
          note="Fresh means the latest snapshot is at most 15 minutes old."
        />
        <OverviewRow
          label="Low remaining"
          value={String(summary.lowBalanceCount)}
          note="5-hour or weekly balance is at or below 20 percent."
        />
        <OverviewRow
          label="Latest sync"
          value={
            summary.mostRecentSync
              ? formatRelativeTimestamp(summary.mostRecentSync)
              : 'None'
          }
          note={formatTimestamp(summary.mostRecentSync)}
        />
      </dl>
    </section>
  )
}

function OverviewRow({
  label,
  note,
  value,
}: {
  label: string
  note: string
  value: string
}) {
  return (
    <div className="flex items-start justify-between gap-4 px-4 py-3">
      <div className="space-y-1">
        <dt className="text-sm font-medium text-foreground">{label}</dt>
        <dd className="text-sm leading-5 text-muted-foreground">{note}</dd>
      </div>
      <div className="text-right text-base font-semibold text-foreground">
        {value}
      </div>
    </div>
  )
}

function CollectorPanel() {
  return (
    <section className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="border-b border-border px-4 py-3">
        <h2 className="text-base font-semibold">Collector</h2>
      </div>

      <div className="space-y-4 px-4 py-4 text-sm leading-6">
        <ol className="space-y-3">
          <li>
            <p className="font-medium text-foreground">
              Choose hosted or local setup once.
            </p>
            <p className="text-muted-foreground">
              `npm run setup:hosted` points the app and collector at your linked
              cloud project. `npm run setup:local` switches the same files back
              to Docker-based local Supabase.
            </p>
          </li>
          <li>
            <p className="font-medium text-foreground">
              Keep passive discovery enabled.
            </p>
            <p className="text-muted-foreground">
              The `default-home` source catches account switches without extra
              manual work.
            </p>
          </li>
          <li>
            <p className="font-medium text-foreground">
              Promote long-lived accounts into dedicated slots.
            </p>
            <p className="text-muted-foreground">
              Separate `CODEX_HOME` directories keep all important accounts warm
              in the background.
            </p>
          </li>
        </ol>

        <Separator />

        <pre className="overflow-x-auto rounded-md border border-border bg-[#f7f3eb] p-3 text-xs leading-6 text-foreground">
          <code>{`npm run setup:hosted
npm run collector`}</code>
        </pre>
      </div>
    </section>
  )
}

function FilesPanel() {
  const rows = [
    {
      file: '.env.local',
      detail: 'App-side Supabase URL and anon key for the dashboard.',
    },
    {
      file: '.env.collector.local',
      detail: 'Collector-side service role credentials for snapshot writes.',
    },
    {
      file: 'collector.sources.json',
      detail: 'Enabled source slots, including passive discovery and dedicated homes.',
    },
    {
      file: 'ops/com.codex-usage.collector.plist',
      detail: 'LaunchAgent definition for keeping the collector alive on macOS.',
    },
  ]

  return (
    <section className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="border-b border-border px-4 py-3">
        <h2 className="text-base font-semibold">Files</h2>
      </div>

      <ul className="divide-y divide-border">
        {rows.map((row) => (
          <li key={row.file} className="space-y-1 px-4 py-3">
            <p className="font-mono text-xs text-foreground">{row.file}</p>
            <p className="text-sm leading-6 text-muted-foreground">{row.detail}</p>
          </li>
        ))}
      </ul>
    </section>
  )
}

function ErrorBanner({ message }: { message: string }) {
  return (
    <div className="border-b border-[#e1c7bf] bg-[#f7ebe7] px-4 py-3 text-sm text-[#7b4337] sm:px-5">
      <div className="flex items-start gap-3">
        <AlertTriangle className="mt-0.5 size-4 shrink-0" />
        <div className="space-y-1">
          <p className="font-medium">Dashboard data is not ready yet.</p>
          <p>{message}</p>
        </div>
      </div>
    </div>
  )
}

function LoadingState() {
  return (
    <div className="space-y-4 px-4 py-4 sm:px-5">
      <div className="h-10 animate-pulse rounded-sm bg-muted" />
      <div className="h-28 animate-pulse rounded-sm bg-muted" />
      <div className="h-28 animate-pulse rounded-sm bg-muted" />
    </div>
  )
}

function EmptyState() {
  return (
    <div className="px-4 py-8 sm:px-5">
      <h3 className="text-base font-semibold text-foreground">
        No Codex snapshots yet
      </h3>
      <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
        Start the collector after your Supabase env vars are set. The account
        table and detail sections will fill in automatically as soon as a source
        reports usage.
      </p>
    </div>
  )
}

function AccountTable({ accounts }: { accounts: DashboardAccountRow[] }) {
  return (
    <Table className="min-w-[780px]">
      <TableHeader className="bg-[#f7f3eb]">
        <TableRow className="hover:bg-[#f7f3eb]">
          <TableHead className="px-4 sm:px-5">Account</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Plan</TableHead>
          <TableHead>Snapshot</TableHead>
          <TableHead>5-hour</TableHead>
          <TableHead>Weekly</TableHead>
          <TableHead className="pr-4 text-right sm:pr-5">Credits</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {accounts.map((account) => {
          const fresh = isFreshTimestamp(account.last_snapshot_at)

          return (
            <TableRow key={account.id}>
              <TableCell className="px-4 py-3 sm:px-5">
                <div className="space-y-1">
                  <p className="font-medium text-foreground">
                    {account.label ?? account.account_key}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {account.email ?? account.account_key}
                  </p>
                </div>
              </TableCell>
              <TableCell>
                <StatusTag fresh={fresh} />
              </TableCell>
              <TableCell>{account.plan_type ?? 'Unknown'}</TableCell>
              <TableCell>
                <div className="space-y-1">
                  <p className="font-medium text-foreground">
                    {formatRelativeTimestamp(account.last_snapshot_at)}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {formatTimestamp(account.last_snapshot_at)}
                  </p>
                </div>
              </TableCell>
              <TableCell>{percentLabel(account.primary_remaining_percent)}</TableCell>
              <TableCell>
                {percentLabel(account.secondary_remaining_percent)}
              </TableCell>
              <TableCell className="pr-4 text-right sm:pr-5">
                {formatCredits(account)}
              </TableCell>
            </TableRow>
          )
        })}
      </TableBody>
    </Table>
  )
}

function AccountSummaryList({ accounts }: { accounts: DashboardAccountRow[] }) {
  return (
    <div className="divide-y divide-border">
      {accounts.map((account) => {
        const fresh = isFreshTimestamp(account.last_snapshot_at)

        return (
          <div key={account.id} className="space-y-3 px-4 py-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="font-medium text-foreground">
                  {account.label ?? account.account_key}
                </p>
                <p className="truncate text-sm text-muted-foreground">
                  {account.email ?? account.account_key}
                </p>
              </div>
              <StatusTag fresh={fresh} />
            </div>

            <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
              <MetaField label="Plan" value={account.plan_type ?? 'Unknown'} />
              <MetaField
                label="Snapshot"
                value={formatRelativeTimestamp(account.last_snapshot_at)}
              />
              <MetaField
                label="5-hour"
                value={percentLabel(account.primary_remaining_percent)}
              />
              <MetaField
                label="Weekly"
                value={percentLabel(account.secondary_remaining_percent)}
              />
            </dl>
          </div>
        )
      })}
    </div>
  )
}

function AccountSection({ account }: { account: DashboardAccountRow }) {
  const fresh = isFreshTimestamp(account.last_snapshot_at)
  const modelBuckets = getModelBuckets(account)

  return (
    <section className="space-y-5 px-4 py-5 sm:px-5">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-base font-semibold text-foreground">
              {account.label ?? account.account_key}
            </h3>
            <StatusTag fresh={fresh} />
          </div>
          <p className="text-sm text-muted-foreground">
            {account.email ?? 'No email reported yet'}
          </p>
        </div>

        <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2 xl:grid-cols-3">
          <MetaField label="Plan" value={account.plan_type ?? 'Unknown'} />
          <MetaField
            label="Source"
            value={account.source_label ?? account.source_key ?? 'Unknown'}
          />
          <MetaField
            label="Snapshot age"
            value={formatRelativeTimestamp(account.last_snapshot_at)}
          />
          <MetaField
            label="Snapshot time"
            value={formatTimestamp(account.last_snapshot_at)}
          />
          <MetaField label="Credits" value={formatCredits(account)} />
          <MetaField
            label="CODEX_HOME"
            value={account.codex_home ?? 'Not tracked'}
            monospace
          />
        </dl>
      </div>

      <Separator />

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)]">
        <section className="space-y-3">
          <h4 className="text-sm font-semibold text-foreground">Quota windows</h4>
          <UsageRow
            label={formatWindowLabel(account.primary_window_mins)}
            remaining={account.primary_remaining_percent}
            resetsAt={account.primary_resets_at}
          />
          <UsageRow
            label={formatWindowLabel(account.secondary_window_mins)}
            remaining={account.secondary_remaining_percent}
            resetsAt={account.secondary_resets_at}
          />
        </section>

        <section className="space-y-3">
          <h4 className="text-sm font-semibold text-foreground">
            Model-specific buckets
          </h4>

          {modelBuckets.length > 0 ? (
            <>
              <div className="space-y-2 md:hidden">
                {modelBuckets.map((bucket) => (
                  <div
                    key={bucket.key}
                    className="rounded-md border border-border px-3 py-3"
                  >
                    <p className="font-medium text-foreground">{bucket.label}</p>
                    <dl className="mt-2 grid grid-cols-3 gap-3 text-sm">
                      <MetaField label="Plan" value={bucket.planType ?? 'Unknown'} />
                      <MetaField
                        label="5-hour"
                        value={percentLabel(bucket.primaryRemaining)}
                      />
                      <MetaField
                        label="Weekly"
                        value={percentLabel(bucket.secondaryRemaining)}
                      />
                    </dl>
                  </div>
                ))}
              </div>

              <div className="hidden overflow-hidden rounded-md border border-border md:block">
                <Table className="min-w-[420px]">
                  <TableHeader className="bg-[#f7f3eb]">
                    <TableRow className="hover:bg-[#f7f3eb]">
                      <TableHead className="px-3">Bucket</TableHead>
                      <TableHead>Plan</TableHead>
                      <TableHead>5-hour</TableHead>
                      <TableHead className="pr-3">Weekly</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {modelBuckets.map((bucket) => (
                      <TableRow key={bucket.key}>
                        <TableCell className="px-3 py-3 font-medium text-foreground">
                          {bucket.label}
                        </TableCell>
                        <TableCell>{bucket.planType ?? 'Unknown'}</TableCell>
                        <TableCell>{percentLabel(bucket.primaryRemaining)}</TableCell>
                        <TableCell className="pr-3">
                          {percentLabel(bucket.secondaryRemaining)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </>
          ) : (
            <p className="rounded-md border border-dashed border-border bg-[#f7f3eb] px-3 py-3 text-sm leading-6 text-muted-foreground">
              No model-specific buckets recorded for this account.
            </p>
          )}
        </section>
      </div>
    </section>
  )
}

function MetaField({
  label,
  monospace = false,
  value,
}: {
  label: string
  monospace?: boolean
  value: string
}) {
  return (
    <div className="space-y-1">
      <dt className="font-medium text-foreground">{label}</dt>
      <dd
        className={`text-muted-foreground ${monospace ? 'break-all font-mono text-xs' : ''}`}
      >
        {value}
      </dd>
    </div>
  )
}

function StatusTag({ fresh }: { fresh: boolean }) {
  return (
    <span
      className={`inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium ${
        fresh
          ? 'border-[#c8d5ca] bg-[#eef3ee] text-[#3f5c49]'
          : 'border-[#ddcfb5] bg-[#f5f0e3] text-[#7c5f25]'
      }`}
    >
      {fresh ? 'Fresh' : 'Stale'}
    </span>
  )
}

function UsageRow({
  label,
  remaining,
  resetsAt,
}: {
  label: string
  remaining: number | null
  resetsAt: string | null
}) {
  const tone = toneForRemaining(remaining)
  const fillClass =
    tone === 'good'
      ? 'bg-[#56705d]'
      : tone === 'warn'
        ? 'bg-[#8b7341]'
        : tone === 'bad'
          ? 'bg-[#9a5a4b]'
          : 'bg-[#8a8176]'

  return (
    <div className="grid gap-3 rounded-md border border-border px-3 py-3 sm:grid-cols-[140px_minmax(0,1fr)_88px] sm:items-center">
      <div>
        <p className="text-sm font-medium text-foreground">{label}</p>
        <p className="text-xs text-muted-foreground">
          Resets {resetsAt ? formatTimestamp(resetsAt) : 'when Codex reports it'}
        </p>
      </div>
      <div className="h-2 overflow-hidden rounded-sm bg-[#ded5c7]">
        <div
          className={`h-full transition-[width] duration-150 ease-out ${fillClass}`}
          style={{ width: `${remaining ?? 0}%` }}
        />
      </div>
      <p className="text-sm font-medium text-foreground sm:text-right">
        {percentLabel(remaining)}
      </p>
    </div>
  )
}

function toneForRemaining(remaining: number | null) {
  if (remaining == null) {
    return 'unknown' as const
  }

  if (remaining <= 20) {
    return 'bad' as const
  }

  if (remaining <= 50) {
    return 'warn' as const
  }

  return 'good' as const
}

function percentLabel(value: number | null) {
  return value == null ? 'N/A' : `${value}%`
}

function formatCredits(account: DashboardAccountRow) {
  if (account.unlimited_credits) {
    return 'Unlimited'
  }

  if (account.credits_balance == null) {
    return '0'
  }

  return String(account.credits_balance)
}
