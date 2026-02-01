import localforage from 'localforage'

/**
 * Wipes all application data from IndexedDB, localStorage, and sessionStorage
 * Used during master password reset
 */
export async function wipeAllData(): Promise<void> {
  // Wipe IndexedDB via LocalForage (Nuclear)
  try {
    await localforage.clear()
    console.log('IndexedDB cleared')
  } catch (err) {
    console.error('Failed to clear IndexedDB:', err)
  }

  // Wipe localStorage
  try {
    localStorage.clear()
    console.log('localStorage cleared')
  } catch (err) {
    console.error('Failed to clear localStorage:', err)
  }

  // Wipe sessionStorage
  try {
    sessionStorage.clear()
    console.log('sessionStorage cleared')
  } catch (err) {
    console.error('Failed to clear sessionStorage:', err)
  }
}
