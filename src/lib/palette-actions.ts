export const PALETTE_CATEGORY_ORDER = [
    'Actions',
    'Navigation',
    'Settings',
    'Accounts',
    'Addons',
    'Notes',
    'Vault',
    'Saved Addons',
    'Quick Actions',
    'Bulk Operations',
] as const

export type PaletteActionId = 'sync-now' | 'deploy-addon' | 'open-account' | 'check-vault' | 'clear-notifications'

export interface PaletteActionSpec {
    id: PaletteActionId
    label: string
    sublabel: string
    hint: string[]
    aliases: string[]
    /** Disabled actions stay listed but never run. */
    disabled?: boolean
}

export interface PaletteActionContext {
    signedIn: boolean
    syncing: boolean
    accountCount: number
    savedAddonCount: number
    vaultKeyCount: number
    notificationCount: number
}

const SHORTCUT_KEYS: Record<PaletteActionId, string> = {
    'sync-now': 'S',
    'deploy-addon': 'D',
    'open-account': 'O',
    'check-vault': 'V',
    'clear-notifications': 'N',
}

const hintFor = (id: PaletteActionId) => ['Alt', SHORTCUT_KEYS[id]]

export function buildPaletteActions(ctx: PaletteActionContext): PaletteActionSpec[] {
    const specs: PaletteActionSpec[] = [
        {
            id: 'sync-now',
            label: 'Sync now',
            sublabel: !ctx.signedIn ? 'Sign in to sync' : ctx.syncing ? 'Sync in progress' : 'Push pending account changes and your workspace',
            hint: hintFor('sync-now'),
            aliases: ['sync', 'refresh', 'push', 'cloud sync'],
            disabled: !ctx.signedIn || ctx.syncing,
        },
    ]
    if (ctx.savedAddonCount > 0 && ctx.accountCount > 0) {
        specs.push({
            id: 'deploy-addon',
            label: 'Deploy addon to…',
            sublabel: 'Pick a saved addon, then choose accounts and confirm',
            hint: hintFor('deploy-addon'),
            aliases: ['deploy', 'install', 'push addon', 'add addon'],
        })
    }
    if (ctx.accountCount > 0) {
        specs.push({
            id: 'open-account',
            label: 'Open account…',
            sublabel: 'Jump to an account by name',
            hint: hintFor('open-account'),
            aliases: ['account', 'go to account', 'switch account'],
        })
    }
    if (ctx.vaultKeyCount > 0) {
        specs.push({
            id: 'check-vault',
            label: 'Check vault keys',
            sublabel: 'Re-run the health check on your vault keys',
            hint: hintFor('check-vault'),
            aliases: ['vault', 'keys', 'health', 'expiry'],
        })
    }
    if (ctx.notificationCount > 0) {
        specs.push({
            id: 'clear-notifications',
            label: 'Clear notifications',
            sublabel: `Empty the inbox (${ctx.notificationCount})`,
            hint: hintFor('clear-notifications'),
            aliases: ['notifications', 'inbox', 'dismiss', 'clear'],
        })
    }
    return specs
}

export interface ShortcutEventLike {
    altKey: boolean
    ctrlKey: boolean
    metaKey: boolean
    shiftKey: boolean
    code: string
}

export function resolvePaletteShortcut(event: ShortcutEventLike, specs: readonly PaletteActionSpec[]): PaletteActionSpec | null {
    if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return null
    return specs.find(spec => event.code === `Key${SHORTCUT_KEYS[spec.id]}`) ?? null
}
