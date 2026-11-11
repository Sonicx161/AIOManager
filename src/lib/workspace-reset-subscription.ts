import { subscribeWorkspaceChanges } from './workspace-persistence.ts'

/** Vite's per-module HMR context; undefined in Node, tests and production builds. */
interface HotModule {
    dispose(callback: () => void): void
}

export interface WorkspaceResetSubscription {
    /** Install the listener on the first cache use; idempotent per module generation. */
    ensure(): void
    /** Remove the listener: with the owning reset, or across an HMR module swap. */
    release(): void
}

/**
 * Workspace-change ownership for a module-level cache. The listener registers
 * lazily on the first cache use, so importing or resetting an unused helper
 * installs nothing; the owner's reset releases it, and the HMR dispose below
 * keeps superseded module generations from stacking callbacks on the shared
 * persistence module.
 */
export function createWorkspaceResetSubscription(reset: () => void, hot?: HotModule | null): WorkspaceResetSubscription {
    let unsubscribe: (() => void) | null = null
    const release = (): void => {
        unsubscribe?.()
        unsubscribe = null
    }
    const ensure = (): void => {
        if (unsubscribe) return
        unsubscribe = subscribeWorkspaceChanges(reset)
    }
    hot?.dispose(release)
    return { ensure, release }
}
