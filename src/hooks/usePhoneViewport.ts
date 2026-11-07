import { useSyncExternalStore } from 'react'
import { PHONE_QUERY } from '@/lib/menu-presentation'

const subscribe = (notify: () => void) => {
  const query = window.matchMedia(PHONE_QUERY)
  query.addEventListener('change', notify)
  return () => query.removeEventListener('change', notify)
}
const getSnapshot = () => window.matchMedia(PHONE_QUERY).matches
const getServerSnapshot = () => false

export function usePhoneViewport(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}
