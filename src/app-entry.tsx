import { StrictMode } from 'react'
import ReactDOM from 'react-dom/client'

import { BrowserRouter } from 'react-router-dom'
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client'
import { ThemeProvider, preloadActiveSkinTheme } from './contexts/ThemeContext'
import { ErrorBoundary } from './components/common/ErrorBoundary'
import App from './App'
import './index.css'
import { registerServiceWorker, initInstallPrompt } from './lib/pwa'
import { queryClient, queryPersister, QUERY_PERSIST_BUSTER } from '@/lib/query-client'
import { isAdminQueryKey } from '@/lib/admin-session'

initInstallPrompt()
registerServiceWorker()

void preloadActiveSkinTheme().then(() => ReactDOM.createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <PersistQueryClientProvider
      client={queryClient}
      persistOptions={{
        persister: queryPersister,
        buster: QUERY_PERSIST_BUSTER,
        dehydrateOptions: {
          // Successful queries only, minus dashboard queries: those are
          // session-scoped and never reach IndexedDB.
          shouldDehydrateQuery: (query) =>
            query.state.status === 'success' && !isAdminQueryKey(query.queryKey),
        },
      }}
    >
      <BrowserRouter>
        <ThemeProvider>
          <ErrorBoundary>
            <App />
          </ErrorBoundary>
        </ThemeProvider>
      </BrowserRouter>
    </PersistQueryClientProvider>
  </StrictMode>
))
