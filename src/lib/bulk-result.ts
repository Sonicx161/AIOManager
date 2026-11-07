import type { BulkResult } from '@/types/saved-addon'

export function appendBulkResult(target: BulkResult, update: BulkResult): void {
  target.success += update.success
  target.failed += update.failed
  target.errors.push(...update.errors)
  target.details.push(...update.details)
  if (update.cancelled) target.cancelled = (target.cancelled || 0) + update.cancelled
}

// Accounts a deploy question stopped count as stopped, never as done.
export function bulkDoneLine(result: BulkResult): string {
  const stopped = result.cancelled ? `, ${result.cancelled} stopped` : ''
  return `Done: ${result.success} account${result.success !== 1 ? 's' : ''} processed, ${result.failed} failed${stopped}`
}

export function installStopMessage(result: BulkResult): string | null {
  return result.cancelled ? 'Install stopped, nothing changed on this account.' : null
}
