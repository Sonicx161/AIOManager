import { useParams, useNavigate } from 'react-router-dom'
import { useEffect } from 'react'
import { AddonList } from '@/components/addons/AddonList'
import { useAccountStore } from '@/store/accountStore'
import { useDocumentTitle } from '@/hooks/use-document-title'
import { useMaskedAccountLabel } from '@/hooks/useMaskedAccountLabel'

export function AccountDetailPage() {
  const { accountId } = useParams<{ accountId: string }>()
  const navigate = useNavigate()
  const accounts = useAccountStore((state) => state.accounts)
  const hydrated = useAccountStore((state) => state.hydrated)
  const account = accounts.find((acc) => acc.id === accountId)
  const maskedLabel = useMaskedAccountLabel()

  useDocumentTitle((account && maskedLabel(account)) || 'Account')

  useEffect(() => {
    if (!hydrated) return
    // An empty local list means a cleared browser racing the first cloud pull;
    // bouncing here would kill deep links. Only bounce when the account is
    // genuinely absent while other accounts are present.
    if (accountId && accounts.length > 0 && !accounts.some((acc) => acc.id === accountId)) {
      navigate('/', { replace: true })
    }
  }, [accountId, accounts, hydrated, navigate])

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
