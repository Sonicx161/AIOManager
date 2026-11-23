import type { DeployOutcome, MergeResult } from '@/types/saved-addon'

export function getDeploymentSummary(details: Array<{ result: MergeResult }>) {
  const totals = details.reduce(
    (acc, detail) => ({
      added: acc.added + detail.result.added.length,
      removed: acc.removed + (detail.result.removed?.length || 0),
      updated: acc.updated + detail.result.updated.length,
      skipped: acc.skipped + detail.result.skipped.length,
      protected: acc.protected + detail.result.protected.length,
    }),
    { added: 0, removed: 0, updated: 0, skipped: 0, protected: 0 }
  )

  const parts = []
  if (totals.added > 0) parts.push(`${totals.added} installed`)
  if (totals.removed > 0) parts.push(`${totals.removed} removed`)
  if (totals.updated > 0) parts.push(`${totals.updated} refreshed`)
  if (totals.skipped > 0) parts.push(`${totals.skipped} skipped`)
  if (totals.protected > 0) parts.push(`${totals.protected} protected`)

  return parts.length > 0 ? parts.join(', ') : 'No addon changes were needed'
}

export function describeDeployOutcome(outcome: DeployOutcome): string {
  switch (outcome.outcome) {
    case 'kept-both': return `${outcome.name}: kept both copies`
    case 'replaced': return outcome.replacedLabel ? `${outcome.name}: replaced the ${outcome.replacedLabel} copy` : `${outcome.name}: replaced the older copy`
    case 'updated': return `${outcome.name}: updated in place`
    default: return `${outcome.name}: added`
  }
}

const MAX_OUTCOME_LINES = 3

// The decided outcomes (kept both, replaced) per account, at most three plus "+N more";
// plain adds and updates stay in the summary counts.
export function describeDeployOutcomes(details: Array<{ accountId: string; result: MergeResult }>, accountLabel: (accountId: string) => string): string[] {
  const lines = details.flatMap(d => (d.result.outcomes || [])
    .filter(o => o.outcome === 'kept-both' || o.outcome === 'replaced')
    .map(o => `${accountLabel(d.accountId)}, ${describeDeployOutcome(o)}.`))
  if (lines.length <= MAX_OUTCOME_LINES) return lines
  return [...lines.slice(0, MAX_OUTCOME_LINES), `+${lines.length - MAX_OUTCOME_LINES} more.`]
}

function listAccounts(ids: string[], accountLabel: (accountId: string) => string): string {
  const names = [...new Set(ids)].map(accountLabel)
  if (names.length <= MAX_OUTCOME_LINES) return names.join(', ')
  return `${names.slice(0, MAX_OUTCOME_LINES).join(', ')} and ${names.length - MAX_OUTCOME_LINES} more`
}

export function describeDeployFailure(
  result: { success: number; failed: number; errors: Array<{ accountId: string; error: string }> },
  summary: string,
  accountLabel: (accountId: string) => string,
): { title: string; description: string } {
  const first = result.errors[0]
  const why = first?.error ? ` Error: ${first.error}` : ''
  const failedNames = listAccounts(result.errors.map(e => e.accountId), accountLabel)
  if (result.success === 0) {
    return {
      title: 'Deployment Failed',
      description: `Could not deploy to ${failedNames || `${result.failed} account${result.failed !== 1 ? 's' : ''}`}.${why}`,
    }
  }
  return {
    title: 'Deployment Completed with Errors',
    description: `${summary}. Succeeded: ${result.success}, failed: ${result.failed}${failedNames ? ` (${failedNames})` : ''}.${why}`,
  }
}
