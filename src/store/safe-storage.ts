import { StateStorage, createJSONStorage } from 'zustand/middleware'

export const safeLocalStorage: StateStorage = {
    getItem: (name: string): string | null => {
        try {
            const value = localStorage.getItem(name)
            // Trap the specific corruption
            if (value && (value.includes('[object Object]') || value === '[object Object]')) {
                console.warn(`[SafeStorage] Corrupted key detected: ${name}. Wiping.`)
                localStorage.removeItem(name)
                return null
            }
            return value
        } catch (e) {
            console.error(`[SafeStorage] Failed to read ${name}`, e)
            return null
        }
    },
    setItem: (name: string, value: string): void => {
        // Prevent writing corruption
        if (value.includes('[object Object]')) {
            console.warn(`[SafeStorage] Prevented writing corrupted data to ${name}`)
            return
        }
        localStorage.setItem(name, value)
    },
    removeItem: (name: string): void => {
        localStorage.removeItem(name)
    }
}

export const createSafeStorage = () => createJSONStorage(() => safeLocalStorage)
