import { useParams, useNavigate } from 'react-router-dom'
import { useEffect } from 'react'
import { AddonList } from '@/components/addons/AddonList'
import { useAccountStore } from '@/store/accountStore'
import { useSyncStore } from '@/store/syncStore'
import { useDocumentTitle } from '@/hooks/use-document-title'
import { useMaskedAccountLabel } from '@/hooks/useMaskedAccountLabel'

export function AccountDetailPage() {
  const { accountId } = useParams<{ accountId: string }>()
  const navigate = useNavigate()
  const accounts = useAccountStore((state) => state.accounts)
  const hydrated = useAccountStore((state) => state.hydrated)
  const pullCertified = useSyncStore((state) => state.isInitialSyncCompleted)
  const account = accounts.find((acc) => acc.id === accountId)
  const maskedLabel = useMaskedAccountLabel()

  useDocumentTitle((account && maskedLabel(account)) || 'Account')

  useEffect(() => {
    if (!hydrated) return
    // An empty local list can be a cleared browser racing the first cloud pull;
    // bouncing then would kill deep links. Bounce when the account is absent
    // while other accounts are present, or once the first pull has settled.
    if (accountId && (accounts.length > 0 || pullCertified) && !accounts.some((acc) => acc.id === accountId)) {
      navigate('/', { replace: true })
    }
  }, [accountId, accounts, hydrated, navigate, pullCertified])

  if (!accountId || !hydrated || accounts.length === 0) {
    return (
      <div className="space-y-6">
        <div className="h-40 animate-pulse rounded-2xl bg-muted/40" />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <AddonList accountId={accountId} />
    </div>
  )
}
