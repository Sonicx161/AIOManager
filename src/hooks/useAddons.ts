import { useAccountStore } from '@/store/accountStore'

export function useAddons(accountId?: string) {
  const installAddon = useAccountStore((state) => state.installAddonToAccount)
  const removeAddon = useAccountStore((state) => state.removeAddonFromAccount)
  const loading = useAccountStore((state) => state.loading)
  const error = useAccountStore((state) => state.error)

  const account = useAccountStore((state) =>
    accountId ? state.accounts.find((acc) => acc.id === accountId) : null
  )

  const addons = account?.addons || []

  return {
    addons,
    loading,
    error,
    installAddon,
    removeAddon,
  }
}
