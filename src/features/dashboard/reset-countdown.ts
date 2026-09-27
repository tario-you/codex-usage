export function formatResetCountdown(value: Date | string | null | undefined) {
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

  if (days > 0) {
    return `in ${days}d ${hours}h`
  }

  if (hours > 0) {
    return `in ${hours}h ${minutes}m`
  }

  return `in ${minutes}m`
}
