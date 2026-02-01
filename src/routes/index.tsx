import { Routes, Route, Navigate } from 'react-router-dom'
import { AccountsPage } from '@/pages/AccountsPage'
import { AccountDetailPage } from '@/pages/AccountDetailPage'
import { SavedAddonsPage } from '@/pages/SavedAddonsPage'
import { NotFoundPage } from '@/pages/NotFoundPage'

import { ActivityPage } from '@/pages/ActivityPage'
import { MetricsPage } from '@/pages/MetricsPage'
import { SettingsPage } from '@/pages/SettingsPage'
import { FAQPage } from '@/pages/FAQPage'

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<AccountsPage />} />
      <Route path="/saved-addons" element={<SavedAddonsPage />} />

      <Route path="/activity" element={<ActivityPage />} />
      <Route path="/metrics" element={<MetricsPage />} />
      <Route path="/settings" element={<SettingsPage />} />
      <Route path="/faq" element={<FAQPage />} />
      <Route path="/account/:accountId" element={<AccountDetailPage />} />
      <Route path="/404" element={<NotFoundPage />} />
      <Route path="*" element={<Navigate to="/404" replace />} />
    </Routes>
  )
}

