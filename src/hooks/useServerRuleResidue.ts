import { useEffect, useState } from 'react'
import { apiFetch } from '@/lib/http-client'
import type { FailoverRule } from '@/store/failoverStore'

interface ResidueRule {
  ruleId: string
  accountId: string
  platform?: string
  connectionId?: string | null
}

export function useServerRuleResidue(owner: string, signedIn: boolean, serverUrl: string, certifiedAccountIds: string[] | null): { rules: FailoverRule[]; forget: (ruleId: string) => void } {
  const [snapshot, setSnapshot] = useState<{ owner: string; serverUrl: string; rules: ResidueRule[] } | null>(null)
  const accountKey = certifiedAccountIds ? JSON.stringify([...certifiedAccountIds].sort()) : null
  useEffect(() => {
    if (!signedIn || accountKey === null) return
    const abort = new AbortController()
    void apiFetch<{ rules?: ResidueRule[] }>('/accounts/server-residue', { baseUrl: serverUrl, signal: abort.signal }).then(result => {
      if (abort.signal.aborted || !result.ok || !Array.isArray(result.data?.rules)) return
      const rules = result.data.rules.filter(rule => typeof rule.ruleId === 'string' && !!rule.ruleId && typeof rule.accountId === 'string' && !!rule.accountId)
      setSnapshot({ owner, serverUrl, rules })
    })
    return () => abort.abort()
  }, [owner, signedIn, serverUrl, accountKey])
  const forget = (ruleId: string) => setSnapshot(previous => previous?.owner === owner && previous.serverUrl === serverUrl
    ? { ...previous, rules: previous.rules.filter(rule => rule.ruleId !== ruleId) } : previous)
  if (!signedIn || certifiedAccountIds === null || snapshot?.owner !== owner || snapshot.serverUrl !== serverUrl) return { rules: [], forget }
  const live = new Set(certifiedAccountIds)
  const rules: FailoverRule[] = snapshot.rules.filter(rule => !live.has(rule.accountId)).map(rule => ({
    id: rule.ruleId,
    accountId: rule.accountId,
    priorityChain: [],
    isActive: false,
    status: 'idle',
    platform: rule.platform,
    connectionId: rule.connectionId || undefined,
  }))
  return { rules, forget }
}
