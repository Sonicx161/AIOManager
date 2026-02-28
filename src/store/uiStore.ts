import { StremioAccount } from '@/types/account'
import { create } from 'zustand'

interface UIStore {
  isAddAccountDialogOpen: boolean
  isAddAddonDialogOpen: boolean
  isExportDialogOpen: boolean
  isImportDialogOpen: boolean
  isPrivacyModeEnabled: boolean
  isWhatsNewOpen: boolean
  libraryViewMode: 'grid' | 'list'

  openAddAccountDialog: (account?: StremioAccount) => void
  closeAddAccountDialog: () => void
  openAddAddonDialog: (accountId: string) => void
  closeAddAddonDialog: () => void
  openExportDialog: () => void
  closeExportDialog: () => void
  openImportDialog: () => void
  closeImportDialog: () => void
  setWhatsNewOpen: (open: boolean) => void
  togglePrivacyMode: () => void
  setLibraryViewMode: (mode: 'grid' | 'list') => void
  initialize: () => void
  editingAccount: StremioAccount | null
  selectedAccountId: string | null
}

const PRIVACY_MODE_KEY = 'stremio-manager:privacy-mode'
const VIEW_MODE_KEY = 'stremio-manager:library-view-mode'

export const useUIStore = create<UIStore>((set, get) => ({
  isAddAccountDialogOpen: false,
  isAddAddonDialogOpen: false,
  isExportDialogOpen: false,
  isImportDialogOpen: false,
  isPrivacyModeEnabled: false,
  isWhatsNewOpen: false,
  libraryViewMode: 'grid',

  editingAccount: null,
  selectedAccountId: null,

  openAddAccountDialog: (account?: StremioAccount) =>
    set({ isAddAccountDialogOpen: true, editingAccount: account || null }),
  closeAddAccountDialog: () => set({ isAddAccountDialogOpen: false, editingAccount: null }),
  openAddAddonDialog: (accountId: string) =>
    set({ isAddAddonDialogOpen: true, selectedAccountId: accountId }),
  closeAddAddonDialog: () => set({ isAddAddonDialogOpen: false, selectedAccountId: null }),
  openExportDialog: () => set({ isExportDialogOpen: true }),
  closeExportDialog: () => set({ isExportDialogOpen: false }),
  openImportDialog: () => set({ isImportDialogOpen: true }),
  closeImportDialog: () => set({ isImportDialogOpen: false }),
  setWhatsNewOpen: (open: boolean) => set({ isWhatsNewOpen: open }),
  togglePrivacyMode: () => {
    const newValue = !get().isPrivacyModeEnabled
    set({ isPrivacyModeEnabled: newValue })
    localStorage.setItem(PRIVACY_MODE_KEY, JSON.stringify(newValue))
  },
  setLibraryViewMode: (mode) => {
    set({ libraryViewMode: mode })
    localStorage.setItem(VIEW_MODE_KEY, mode)
  },
  initialize: () => {
    const storedPrivacy = localStorage.getItem(PRIVACY_MODE_KEY)
    if (storedPrivacy !== null) {
      try {
        set({ isPrivacyModeEnabled: JSON.parse(storedPrivacy) })
      } catch (e) {
        console.warn('Failed to parse privacy mode setting:', e)
        localStorage.removeItem(PRIVACY_MODE_KEY)
      }
    }

    const storedViewMode = localStorage.getItem(VIEW_MODE_KEY)
    if (storedViewMode === 'grid' || storedViewMode === 'list') {
      set({ libraryViewMode: storedViewMode })
    }
  },
}))
