import { create } from 'zustand'
import { subscribeToToasts } from '../hooks/use-toast.ts'
import {
  INBOX_CAP,
  isRecordable,
  markAllRead,
  markRead,
  markSeen,
  parseStoredEntries,
  recordEntry,
  type InboxEntry,
} from '../lib/notification-history.ts'

const storageKey = (workspaceId: string) => `aiom:inbox:${workspaceId}`

function persist(workspaceId: string | null, entries: InboxEntry[]) {
  if (!workspaceId || typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(storageKey(workspaceId), JSON.stringify(entries))
  } catch {
    // storage unavailable or full
  }
}

function readStored(workspaceId: string): InboxEntry[] {
  if (typeof localStorage === 'undefined') return []
  try {
    const raw = localStorage.getItem(storageKey(workspaceId))
    return parseStoredEntries(raw ? JSON.parse(raw) : [])
  } catch {
    return []
  }
}

interface InboxState {
  workspaceId: string | null
  entries: InboxEntry[]
  load: (workspaceId: string) => void
  record: (toast: Parameters<typeof recordEntry>[1]) => void
  markAllRead: () => void
  markRead: (id: string) => void
  markSeen: () => void
  clear: () => void
}

export const useInboxStore = create<InboxState>((set, get) => {
  const commit = (entries: InboxEntry[]) => {
    persist(get().workspaceId, entries)
    set({ entries })
  }

  return {
    workspaceId: null,
    entries: [],

    load: (workspaceId) => {
      const { workspaceId: current, entries: live } = get()
      if (current === workspaceId) return
      const stored = readStored(workspaceId)
      let entries = stored
      if (current === null && live.length > 0) {
        const seen = new Set(stored.map(e => e.id))
        entries = [...live.filter(e => !seen.has(e.id)), ...stored].sort((a, b) => b.at - a.at).slice(0, INBOX_CAP)
      }
      persist(workspaceId, entries)
      set({ workspaceId, entries })
    },

    record: (toast) => {
      if (!isRecordable(toast)) return
      commit(recordEntry(get().entries, toast, Date.now()))
    },

    markAllRead: () => commit(markAllRead(get().entries)),
    markRead: (id) => commit(markRead(get().entries, id)),
    markSeen: () => commit(markSeen(get().entries)),
    clear: () => commit([]),
  }
})

subscribeToToasts((t) => {
  useInboxStore.getState().record({ id: t.id, title: t.title, description: t.description, variant: t.variant === 'attention' ? 'warning' : t.variant, href: t.href, accountId: t.accountId, history: t.history, actionHint: t.actionHint, actionTarget: t.actionTarget })
})
