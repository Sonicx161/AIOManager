import { useParams, useNavigate } from 'react-router-dom'
import { useEffect } from 'react'
import { AddonList } from '@/components/addons/AddonList'
import { useAccountStore } from '@/store/accountStore'

export function AccountDetailPage() {
  const { accountId } = useParams<{ accountId: string }>()
  const navigate = useNavigate()
  const accounts = useAccountStore((state) => state.accounts)

  // Check if account exists
  useEffect(() => {
    if (accountId) {
      const account = accounts.find((acc) => acc.id === accountId)
      if (!account) {
        // Account not found, redirect to home
        navigate('/', { replace: true })
      }
    }
  }, [accountId, accounts, navigate])

  if (!accountId) {
    return null
  }

  return (
    <div className="space-y-6">
      <AddonList accountId={accountId} />
    </div>
  )
}
