import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, RefreshCcw } from 'lucide-react'

import { Button } from '@/components/ui/button'
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
  type DashboardAccountRow,
} from '@/lib/dashboard'
import {
  formatRelativeTimestamp,
  formatTimestamp,
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
            <h1 className="text-[1.75rem] font-semibold tracking-[-0.02em]">
              Codex usage
            </h1>

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

        <div className="flex-1 px-4 py-6 sm:px-6 lg:px-8">
          <section className="overflow-hidden rounded-lg border border-border bg-card">
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
              </>
            ) : null}
          </section>
        </div>
      </div>
    </main>
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
        list will fill in automatically as soon as a source reports usage.
      </p>
    </div>
  )
}

function AccountTable({ accounts }: { accounts: DashboardAccountRow[] }) {
  return (
    <Table className="min-w-[760px]">
      <TableHeader className="bg-[#f7f3eb]">
        <TableRow className="hover:bg-[#f7f3eb]">
          <TableHead className="px-4 sm:px-5">Account</TableHead>
          <TableHead>Snapshot</TableHead>
          <TableHead>5-hour</TableHead>
          <TableHead>Weekly</TableHead>
          <TableHead className="pr-4 sm:pr-5">Weekly reset</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {accounts.map((account) => {
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
              <TableCell className="pr-4 sm:pr-5">
                <div className="space-y-1">
                  <p className="font-medium text-foreground">
                    {formatTimestamp(account.secondary_resets_at)}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {formatResetCountdown(account.secondary_resets_at)}
                  </p>
                </div>
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
        return (
          <div key={account.id} className="space-y-3 px-4 py-3">
            <div className="min-w-0">
              <p className="font-medium text-foreground">
                {account.label ?? account.account_key}
              </p>
              <p className="truncate text-sm text-muted-foreground">
                {account.email ?? account.account_key}
              </p>
            </div>

            <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
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
              <MetaField
                label="Weekly resets in"
                value={formatResetCountdown(account.secondary_resets_at)}
              />
              <MetaField
                label="Weekly resets at"
                value={formatTimestamp(account.secondary_resets_at)}
              />
            </dl>
          </div>
        )
      })}
    </div>
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

function percentLabel(value: number | null) {
  return value == null ? 'N/A' : `${value}%`
}

function formatResetCountdown(value: Date | string | null | undefined) {
  if (!value) {
    return 'N/A'
  }

  const resetAt = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(resetAt.getTime())) {
    return 'N/A'
  }

  const remainingMs = Math.max(0, resetAt.getTime() - Date.now())
  const totalMinutes = Math.floor(remainingMs / 60000)
  const days = Math.floor(totalMinutes / (24 * 60))
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60)
  const minutes = totalMinutes % 60

  const dayLabel = days === 1 ? 'Day' : 'Days'
  const hourLabel = hours === 1 ? 'Hour' : 'Hours'
  const minuteLabel = minutes === 1 ? 'Minute' : 'Minutes'

  return `${days} ${dayLabel} ${hours} ${hourLabel} ${minutes} ${minuteLabel}`
}
