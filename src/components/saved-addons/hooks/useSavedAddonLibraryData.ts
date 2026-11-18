import { useMemo } from 'react'
import { getHealthSummary } from '@/lib/addon-health'
import { getLatestAddonVersion, isNewerVersion, normalizeAddonUrl } from '@/lib/utils'
import { sortSavedAddons } from '@/lib/library-sort'
import type { Account } from '@/types/account'
import type { Profile } from '@/types/profile'
import type { AccountAddonState, SavedAddon, SavedAddonManifestChangeSummary } from '@/types/saved-addon'

export interface SavedAddonDeploymentSummary {
  deployedAccounts: Account[]
}

interface UseSavedAddonLibraryDataOptions {
  library: Record<string, SavedAddon>
  getAllTags: () => string[]
  profiles: Profile[]
  accountStates: Record<string, AccountAddonState>
  accounts: Account[]
  selectedProfileId: string | null
  selectedTag: string | null
  debouncedSearchQuery: string
  latestVersions: Record<string, string>
  manifestChangeHints: Record<string, SavedAddonManifestChangeSummary>
}

const NO_DEPLOYED_ACCOUNTS: Account[] = []

function getSafeAddonUrlKey(value: unknown) {
  if (typeof value !== 'string' || !value.trim()) return null

  try {
    return normalizeAddonUrl(value)
  } catch {
    return null
  }
}

export function useSavedAddonLibraryData({
  library,
  getAllTags,
  profiles,
  accountStates,
  accounts,
  selectedProfileId,
  selectedTag,
  debouncedSearchQuery,
  latestVersions,
  manifestChangeHints,
}: UseSavedAddonLibraryDataOptions) {
  const savedAddons = useMemo(() => Object.values(library), [library])
  const allTags = getAllTags()

  const filteredAddons = useMemo(() => {
    let filtered = savedAddons

    if (debouncedSearchQuery) {
      const query = debouncedSearchQuery.toLowerCase()
      filtered = filtered.filter(
        (addon) =>
          addon.name.toLowerCase().includes(query) ||
          addon.tags.some((tag) => tag.toLowerCase().includes(query)) ||
          (typeof addon.installUrl === 'string' && addon.installUrl.toLowerCase().includes(query))
      )
    }

    if (selectedProfileId === 'unassigned') {
      filtered = filtered.filter((addon) => !addon.profileId || !profiles.some(p => p.id === addon.profileId))
    } else if (selectedProfileId) {
      filtered = filtered.filter((addon) => addon.profileId === selectedProfileId)
    }

    if (selectedTag) {
      filtered = filtered.filter((addon) => addon.tags.includes(selectedTag))
    }

    return sortSavedAddons(filtered, 'custom')
  }, [savedAddons, debouncedSearchQuery, selectedTag, selectedProfileId, profiles])

  const healthSummary = useMemo(() => {
    return getHealthSummary(savedAddons)
  }, [savedAddons])

  const updatesCount = useMemo(() => {
    return savedAddons.filter(addon => {
      const latest = getLatestAddonVersion(latestVersions, {
        transportUrl: addon.installUrl,
        manifest: addon.manifest,
      })
      return (latest && isNewerVersion(addon.manifest.version, latest)) || manifestChangeHints[addon.id]?.hasManifestShapeChange
    }).length
  }, [savedAddons, latestVersions, manifestChangeHints])

  const tagCounts = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const addon of savedAddons) {
      for (const tag of addon.tags) {
        counts[tag] = (counts[tag] || 0) + 1
      }
    }
    return counts
  }, [savedAddons])

  const profileAddonCounts = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const addon of savedAddons) {
      if (addon.profileId) {
        counts[addon.profileId] = (counts[addon.profileId] || 0) + 1
      }
    }
    return counts
  }, [savedAddons])

  const unassignedCount = useMemo(() => {
    return savedAddons.filter(a => !a.profileId || !profiles.some(p => p.id === a.profileId)).length
  }, [savedAddons, profiles])

  const deployedAccountsByUrl = useMemo(() => {
    const accountById = new Map(accounts.map(account => [account.id, account]))

    const urlToAccountIds = new Map<string, Set<string>>()

    for (const accountState of Object.values(accountStates)) {
      const accountId = accountState.accountId
      if (!accountById.has(accountId)) continue

      for (const installedAddon of accountState.installedAddons) {
        const urlKey = getSafeAddonUrlKey(installedAddon.installUrl)
        if (!urlKey) continue
        let set = urlToAccountIds.get(urlKey)
        if (!set) { set = new Set(); urlToAccountIds.set(urlKey, set) }
        set.add(accountId)
      }
    }

    const byUrl = new Map<string, Account[]>()
    for (const [urlKey, accountIds] of urlToAccountIds) {
      byUrl.set(urlKey, Array.from(accountIds)
        .map(id => accountById.get(id))
        .filter((a): a is Account => Boolean(a)))
    }
    return byUrl
  }, [accountStates, accounts])

  const deploymentSummaryByAddonId = useMemo(() => {
    // Match by normalized configured URL only. A recorded savedAddonId (or a shared
    // manifest id) can outlive a URL change, and a different URL is a different addon
    // instance — so neither may count as "installed on this account".
    const summaries: Record<string, SavedAddonDeploymentSummary> = {}
    for (const addon of savedAddons) {
      const key = getSafeAddonUrlKey(addon.installUrl)
      summaries[addon.id] = {
        deployedAccounts: (key && deployedAccountsByUrl.get(key)) || NO_DEPLOYED_ACCOUNTS
      }
    }

    return summaries
  }, [deployedAccountsByUrl, savedAddons])

  const syncOverviewData = useMemo(() => {
    const syncingAddons = savedAddons.filter(a => {
      const matchesSync = a.syncWithInstalled
      if (!matchesSync) return false

      if (selectedProfileId === 'unassigned') {
        return !a.profileId || !profiles.some(p => p.id === a.profileId)
      }
      if (selectedProfileId) {
        return a.profileId === selectedProfileId
      }
      return true
    })

    if (syncingAddons.length === 0) return []

    const results = syncingAddons.map(savedAddon => ({
      addon: savedAddon,
      deployedAccounts: deploymentSummaryByAddonId[savedAddon.id]?.deployedAccounts ?? [],
    }))

    return results.filter(item => item.deployedAccounts.length > 0)
  }, [deploymentSummaryByAddonId, savedAddons, selectedProfileId, profiles])

  const notSyncingDeployed = useMemo(() => {
    return savedAddons
      .filter(a => {
        if (a.syncWithInstalled) return false
        if (selectedProfileId === 'unassigned') {
          return !a.profileId || !profiles.some(p => p.id === a.profileId)
        }
        if (selectedProfileId) {
          return a.profileId === selectedProfileId
        }
        return true
      })
      .flatMap(addon => {
        const deployedAccounts = deploymentSummaryByAddonId[addon.id]?.deployedAccounts ?? []
        if (deployedAccounts.length === 0) return []
        return [{ addon, deployedAccounts }]
      })
  }, [deploymentSummaryByAddonId, savedAddons, selectedProfileId, profiles])

  return {
    savedAddons,
    allTags,
    filteredAddons,
    healthSummary,
    updatesCount,
    tagCounts,
    profileAddonCounts,
    unassignedCount,
    deploymentSummaryByAddonId,
    syncOverviewData,
    notSyncingDeployed,
  }
}
