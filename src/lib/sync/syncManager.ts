/**
 * SyncManager
 * Manages pending operations to prevent race conditions during synchronization.
 * Specifically helps avoid "Zombie Addons" by tracking deletions.
 */

export type OperationType = 'remove' | 'add' | 'update'

export interface PendingOperation {
    accountId: string
    targetId: string // Usually transportUrl or manifestId
    type: OperationType
    timestamp: number
}

class SyncManager {
    private pendingRemovals: Map<string, Set<string>> = new Map()
    private observers: Set<() => void> = new Set()

    /**
     * Mark an addon as "Deleting" for a specific account.
     * This ensures that any background PULLs from Stremio ignore this addon 
     * until the deletion is confirmed or timed out.
     */
    addPendingRemoval(accountId: string, transportUrl: string) {
        if (!this.pendingRemovals.has(accountId)) {
            this.pendingRemovals.set(accountId, new Set())
        }
        this.pendingRemovals.get(accountId)!.add(transportUrl.toLowerCase())
        this.notify()
    }

    /**
     * Unmark an addon.
     */
    removePendingRemoval(accountId: string, transportUrl: string) {
        const set = this.pendingRemovals.get(accountId)
        if (set) {
            set.delete(transportUrl.toLowerCase())
            if (set.size === 0) this.pendingRemovals.delete(accountId)
            this.notify()
        }
    }

    /**
     * Check if an addon is currently pending deletion.
     */
    isPendingRemoval(accountId: string, transportUrl: string): boolean {
        const set = this.pendingRemovals.get(accountId)
        return set ? set.has(transportUrl.toLowerCase()) : false
    }

    /**
     * Clear all pending operations for an account.
     */
    clearAccount(accountId: string) {
        this.pendingRemovals.delete(accountId)
        this.notify()
    }

    subscribe(callback: () => void) {
        this.observers.add(callback)
        return () => this.observers.delete(callback)
    }

    private notify() {
        this.observers.forEach(cb => cb())
    }
}

export const syncManager = new SyncManager()
