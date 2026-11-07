import { vaultKeyLabel } from './vault-key-label.ts'

export type VaultKeyFieldId = 'value' | 'serverUrl' | 'addonUuid'

export interface ActionableKey {
  id: string
  name?: string
  customProviderName?: string
  provider: string
  value: string
  serverUrl?: string
  addonUuid?: string
  customDashboardUrl?: string
}

export interface ToastLike {
  title: string
  description?: string
  variant?: 'default' | 'destructive' | 'warning'
  history?: boolean
  duration?: number
  action?: { label: string; onClick: () => void }
}

export interface CopyDeps {
  getKey: (id: string) => ActionableKey | undefined
  isLocked: () => boolean
  writeText: (text: string) => Promise<void>
  notify: (toast: ToastLike) => void
  promptUnlock: () => void
  openVault: () => void
}

export type CopyResult = 'copied' | 'locked' | 'missing' | 'failed'

const FIELD_LABELS: Record<VaultKeyFieldId, string> = {
  value: 'API key',
  serverUrl: 'Server URL',
  addonUuid: 'Addon UUID',
}

export function copyableFields(key: ActionableKey): { id: VaultKeyFieldId; label: string }[] {
  const ids: VaultKeyFieldId[] = ['value', 'serverUrl', 'addonUuid']
  return ids.filter(id => !!key[id]).map(id => ({ id, label: FIELD_LABELS[id] }))
}

export function primaryField(key: ActionableKey): VaultKeyFieldId | null {
  return copyableFields(key)[0]?.id ?? null
}

// Toasts here are not inbox-worthy and never carry the copied value.
export async function copyVaultKeyField(id: string, field: VaultKeyFieldId | null, deps: CopyDeps): Promise<CopyResult> {
  if (deps.isLocked()) {
    deps.notify({
      title: 'Vault is locked',
      description: 'Unlock the vault to copy keys.',
      variant: 'warning',
      history: false,
      action: { label: 'Unlock', onClick: deps.promptUnlock },
    })
    return 'locked'
  }
  const key = deps.getKey(id)
  const target = field ?? (key ? primaryField(key) : null)
  const text = key && target ? key[target] : undefined
  if (!key || !target || !text) {
    deps.notify({ title: 'Key not found', description: 'This vault entry has no value to copy.', variant: 'destructive', history: false })
    return 'missing'
  }
  const label = vaultKeyLabel(key)
  try {
    await deps.writeText(text)
  } catch {
    deps.notify({
      title: `Could not copy ${label} key`,
      description: 'Clipboard access was denied. Open the Vault to copy it there.',
      variant: 'destructive',
      history: false,
      action: { label: 'Open Vault', onClick: deps.openVault },
    })
    return 'failed'
  }
  deps.notify({
    title: target === 'value' ? `Copied ${label} key` : `Copied ${label} ${FIELD_LABELS[target].toLowerCase()}`,
    variant: 'default',
    history: false,
    duration: 2500,
  })
  return 'copied'
}

function httpUrl(raw: string | undefined): string | null {
  if (!raw) return null
  try {
    const url = new URL(raw)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null
  } catch {
    return null
  }
}

export function resolveRenewUrl(key: Pick<ActionableKey, 'customDashboardUrl'>, ...fallbacks: Array<string | undefined>): string | null {
  for (const candidate of [key.customDashboardUrl, ...fallbacks]) {
    const url = httpUrl(candidate)
    if (url) return url
  }
  return null
}

export function filterHeaderEntries<T extends { key: { name?: string; customProviderName?: string; provider: string; group?: string } }>(
  entries: readonly T[],
  query: string,
  providerLabel: (provider: string) => string,
): T[] {
  const q = query.trim().toLowerCase()
  if (!q) return [...entries]
  return entries.filter(({ key }) =>
    [vaultKeyLabel(key), providerLabel(key.provider), key.group ?? ''].some(part => part.toLowerCase().includes(q)),
  )
}
