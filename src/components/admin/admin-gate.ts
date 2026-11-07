/**
 * Pure gate for the /dashboard route. The dashboard renders only when
 * GET /api/admin/status reports enabled; any other outcome shows the normal 404,
 * the setup screen or the sign-in screen.
 */
import type { AdminStatus } from '@/api/admin'

export type AdminGateState = 'loading' | 'disabled' | 'setup' | 'signin' | 'ready'

export function resolveAdminGate(
  status: AdminStatus | null | undefined,
  statusError: { status: number } | null,
): AdminGateState {
  // When ADMIN_ENABLED is off the route does not exist server-side: the status
  // call fails (404) or reports enabled false, and the UI must look absent.
  if (statusError || !status) return 'disabled'
  if (!status.enabled) return 'disabled'
  if (status.setupRequired) return 'setup'
  if (!status.signedIn) return 'signin'
  return 'ready'
}
