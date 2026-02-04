import { StremioAccount } from '@/types/account'
import { create } from 'zustand'

interface UIStore {
  isAddAccountDialogOpen: boolean
  isAddAddonDialogOpen: boolean
  isExportDialogOpen: boolean
  isImportDialogOpen: boolean
  isPrivacyModeEnabled: boolean

  openAddAccountDialog: (account?: StremioAccount) => void
  closeAddAccountDialog: () => void
  openAddAddonDialog: (accountId: string) => void
  closeAddAddonDialog: () => void
  openExportDialog: () => void
  closeExportDialog: () => void
  openImportDialog: () => void
  closeImportDialog: () => void
  togglePrivacyMode: () => void
  initialize: () => void
  editingAccount: StremioAccount | null
  selectedAccountId: string | null
}

const PRIVACY_MODE_KEY = 'stremio-manager:privacy-mode'

export const useUIStore = create<UIStore>((set, get) => ({
  isAddAccountDialogOpen: false,
  isAddAddonDialogOpen: false,
  isExportDialogOpen: false,
  isImportDialogOpen: false,
  isPrivacyModeEnabled: false,

  editingAccount: null,
  selectedAccountId: null,

  openAddAccountDialog: (account) =>
    set({ isAddAccountDialogOpen: true, editingAccount: account || null }),
  closeAddAccountDialog: () => set({ isAddAccountDialogOpen: false, editingAccount: null }),
  openAddAddonDialog: (accountId) =>
    set({ isAddAddonDialogOpen: true, selectedAccountId: accountId }),
  closeAddAddonDialog: () => set({ isAddAddonDialogOpen: false, selectedAccountId: null }),
  openExportDialog: () => set({ isExportDialogOpen: true }),
  closeExportDialog: () => set({ isExportDialogOpen: false }),
  openImportDialog: () => set({ isImportDialogOpen: true }),
  closeImportDialog: () => set({ isImportDialogOpen: false }),
  togglePrivacyMode: () => {
    const newValue = !get().isPrivacyModeEnabled
    set({ isPrivacyModeEnabled: newValue })
    localStorage.setItem(PRIVACY_MODE_KEY, JSON.stringify(newValue))
  },
  initialize: () => {
    const stored = localStorage.getItem(PRIVACY_MODE_KEY)
    if (stored !== null) {
      set({ isPrivacyModeEnabled: JSON.parse(stored) })
    }
  },
}))
