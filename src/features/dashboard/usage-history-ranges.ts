// The chart's ranges and the RPC's time bucket for each. Pure, so tests can
// import it without the Vite environment the Supabase client needs.
//
// #31: the history RPC answers one row per time bucket. supabase-js returns at
// most POSTGREST_MAX_ROWS rows per call, and one row per snapshot timestamp
// overran that within a day once every login synced on its own clock, so each
// range names a bucket that keeps its points well under the cap.
export const POSTGREST_MAX_ROWS = 1000

export const dashboardWeeklyUsageRanges = [
  { bucketSeconds: 5 * 60, days: 1, label: '1 day', value: '1d' },
  { bucketSeconds: 15 * 60, days: 7, label: '7 day', value: '7d' },
  { bucketSeconds: 60 * 60, days: 30, label: '30 day', value: '30d' },
] as const

export type DashboardWeeklyUsageRange =
  (typeof dashboardWeeklyUsageRanges)[number]['value']

export function getDashboardWeeklyUsageRangeDays(
  range: DashboardWeeklyUsageRange,
) {
  return (
    dashboardWeeklyUsageRanges.find((option) => option.value === range)?.days ?? 7
  )
}

/** The RPC's time bucket for a range: one point per bucket, never near the row cap (#31). */
export function getDashboardWeeklyUsageBucketSeconds(
  range: DashboardWeeklyUsageRange,
) {
  return (
    dashboardWeeklyUsageRanges.find((option) => option.value === range)
      ?.bucketSeconds ?? 15 * 60
  )
}
