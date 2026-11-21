import { useState } from 'react'

export function useEverTrue(flag: boolean): boolean {
  const [seen, setSeen] = useState(flag)
  if (flag && !seen) setSeen(true)
  return seen || flag
}
