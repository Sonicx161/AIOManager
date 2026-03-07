import { StremioAccount } from '@/types/account'
import { create } from 'zustand'

interface UIStore {
  isAddAccountDialogOpen: boolean
  isAddAddonDialogOpen: boolean

  isPrivacyModeEnabled: boolean
  isWhatsNewOpen: boolean
  libraryViewMode: 'grid' | 'list'

  openAddAccountDialog: (account?: StremioAccount) => void
  closeAddAccountDialog: () => void
  openAddAddonDialog: (accountId: string) => void
  closeAddAddonDialog: () => void

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

  isPrivacyModeEnabled: (() => {
    try {
      const stored = localStorage.getItem(PRIVACY_MODE_KEY)
      return stored !== null ? JSON.parse(stored) : false
    } catch { return false }
  })(),
  isWhatsNewOpen: false,
  libraryViewMode: (() => {
    try {
      const stored = localStorage.getItem(VIEW_MODE_KEY)
      return stored === 'grid' || stored === 'list' ? stored as 'grid' | 'list' : 'grid'
    } catch { return 'grid' }
  })(),

  editingAccount: null,
  selectedAccountId: null,

  openAddAccountDialog: (account?: StremioAccount) =>
    set({ isAddAccountDialogOpen: true, editingAccount: account || null }),
  closeAddAccountDialog: () => set({ isAddAccountDialogOpen: false, editingAccount: null }),
  openAddAddonDialog: (accountId: string) =>
    set({ isAddAddonDialogOpen: true, selectedAccountId: accountId }),
  closeAddAddonDialog: () => set({ isAddAddonDialogOpen: false, selectedAccountId: null }),

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
    // Privacy mode and viewMode are now eagerly loaded at store creation.
    // This function is kept as a no-op for backwards compatibility.
  },
}))
