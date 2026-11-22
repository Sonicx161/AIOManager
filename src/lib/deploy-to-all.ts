export const DEPLOY_PREVIEW_LIMIT = 6

export const newDeployToastId = () => `deploy-to-all:${crypto.randomUUID()}`

const accountsLabel = (n: number) => `${n} account${n === 1 ? '' : 's'}`

export function deployToAllTargets<T extends { id: string }>(accounts: readonly T[], sourceAccountId: string): T[] {
    return accounts.filter(account => account.id !== sourceAccountId)
}

export function deployToAllCopy(addonLabel: string, targetCount: number) {
    return {
        title: `Add ${addonLabel} to ${accountsLabel(targetCount)}?`,
        description: targetCount === 1
            ? 'It installs on the other account in this workspace.'
            : 'It installs on every other account in this workspace.',
        confirmText: `Deploy to ${accountsLabel(targetCount)}`,
        runningTitle: `Deploying ${addonLabel}`,
        runningDescription: `Adding it to ${accountsLabel(targetCount)}...`,
    }
}

export function deployPreview<T>(targets: readonly T[], expanded = false, limit = DEPLOY_PREVIEW_LIMIT) {
    const shown = !expanded && targets.length > limit + 1 ? targets.slice(0, limit) : targets.slice()
    return { shown, more: targets.length - shown.length }
}

export function deployListToggle(hidden: number, total: number, expanded: boolean) {
    return expanded
        ? { label: 'Show fewer', announcement: `Showing all ${total} accounts` }
        : { label: `and ${hidden} more`, announcement: '' }
}

export interface DeployOutcome {
    succeeded: string[]
    failed: string[]
}

export async function runDeployToAll(targetIds: readonly string[], install: (accountId: string) => Promise<unknown>, concurrency = 1): Promise<DeployOutcome> {
    const outcome: DeployOutcome = { succeeded: [], failed: [] }
    let next = 0
    const worker = async () => {
        while (next < targetIds.length) {
            const id = targetIds[next++]
            try {
                await install(id)
                outcome.succeeded.push(id)
            } catch {
                outcome.failed.push(id)
            }
        }
    }
    await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, targetIds.length)) }, worker))
    return outcome
}

export function deployToAllResult(addonLabel: string, outcome: { succeeded: number; failed: number }) {
    if (outcome.succeeded === 0) {
        return {
            title: 'Deploy to All failed',
            description: `Could not add ${addonLabel} to ${accountsLabel(outcome.failed)}.`,
            variant: 'destructive' as const,
        }
    }
    return {
        title: 'Deploy to All complete',
        description: `Added ${addonLabel} to ${accountsLabel(outcome.succeeded)}.${outcome.failed > 0 ? ` Failed for ${accountsLabel(outcome.failed)}.` : ''}`,
        variant: 'default' as const,
    }
}

export interface DeployRequest<T, P> {
    sourceAccountId: string
    targets: T[]
    payload: P
}

export function createDeployToAllGate<T extends { id: string }, P>() {
    let pending: DeployRequest<T, P> | null = null
    return {
        request(sourceAccountId: string, targets: readonly T[], payload: P): DeployRequest<T, P> | null {
            pending = targets.length > 0 ? { sourceAccountId, targets: [...targets], payload } : null
            return pending
        },
        cancel() { pending = null },
        take(sourceAccountId: string): DeployRequest<T, P> | null {
            const request = pending
            pending = null
            return request && request.sourceAccountId === sourceAccountId ? request : null
        },
    }
}

export function visibleDeployRequest<R extends { sourceAccountId: string }>(request: R | null, sourceAccountId: string): R | null {
    return request && request.sourceAccountId === sourceAccountId ? request : null
}

export interface BulkDeployTally {
    full: number
    partial: number
    none: number
    added: number
    failed: number
    total: number
}

export async function runBulkDeployToAll(
    targetIds: readonly string[],
    addonUrls: readonly string[],
    install: (accountId: string, urls: string[]) => Promise<{ successCount: number; failCount: number }>,
    concurrency = 1,
): Promise<BulkDeployTally | null> {
    if (targetIds.length === 0 || addonUrls.length === 0) return null
    const urls = [...addonUrls]
    const tally: BulkDeployTally = { full: 0, partial: 0, none: 0, added: 0, failed: 0, total: targetIds.length * urls.length }
    await runDeployToAll(targetIds, async (accountId) => {
        let added = 0
        try {
            const result = await install(accountId, urls)
            added = Math.min(result.successCount, urls.length)
        } catch {
            added = 0
        }
        tally.added += added
        tally.failed += urls.length - added
        if (added === urls.length) tally.full++
        else if (added > 0) tally.partial++
        else tally.none++
    }, concurrency)
    return tally
}

export function bulkDeployToAllResult(addonLabel: string, tally: BulkDeployTally | null) {
    if (!tally) {
        return { title: 'Deploy to All failed', description: 'Nothing was deployed: no addons were selected.', variant: 'destructive' as const }
    }
    if (tally.added === 0) {
        return { title: 'Deploy to All failed', description: `Could not add ${addonLabel} to ${accountsLabel(tally.none)}.`, variant: 'destructive' as const }
    }
    const parts = [
        tally.full > 0 ? `Added ${addonLabel} to ${accountsLabel(tally.full)}.` : '',
        tally.partial > 0 ? `Partly added to ${accountsLabel(tally.partial)}.` : '',
        tally.none > 0 ? `Failed for ${accountsLabel(tally.none)}.` : '',
        tally.failed > 0 ? `${tally.failed} of ${tally.total} installs failed.` : '',
    ].filter(Boolean)
    return { title: 'Deploy to All complete', description: parts.join(' '), variant: 'default' as const }
}
