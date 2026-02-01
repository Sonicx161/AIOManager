import { useState, useEffect } from 'react'
import localforage from 'localforage'

export function useLocalStorage<T>(key: string, initialValue: T) {
  const [storedValue, setStoredValue] = useState<T>(initialValue)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    // Load value from storage
    localforage
      .getItem<T>(key)
      .then((value) => {
        if (value !== null) {
          setStoredValue(value)
        }
      })
      .catch((error) => {
        console.error(`Error loading ${key} from storage:`, error)
      })
      .finally(() => {
        setLoading(false)
      })
  }, [key])

  const setValue = async (value: T | ((val: T) => T)) => {
    try {
      const valueToStore = value instanceof Function ? value(storedValue) : value
      setStoredValue(valueToStore)
      await localforage.setItem(key, valueToStore)
    } catch (error) {
      console.error(`Error saving ${key} to storage:`, error)
    }
  }

  return [storedValue, setValue, loading] as const
}
