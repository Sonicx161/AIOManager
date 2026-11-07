import { adminLogin, adminSetup, AdminApiError } from '../../api/admin.ts'

export type SignInFields = { setupToken: string; username: string; password: string; confirmPassword: string; remember: boolean }

export class SignInFormError extends Error {}

export async function submitSignIn(mode: 'signin' | 'setup', fields: SignInFields): Promise<void> {
  if (mode === 'setup') {
    if (fields.password !== fields.confirmPassword) throw new SignInFormError('Passwords do not match')
    await adminSetup({
      setupToken: fields.setupToken.trim(),
      username: fields.username.trim(),
      password: fields.password,
      confirmPassword: fields.confirmPassword,
      remember: fields.remember,
    })
    return
  }
  await adminLogin({ username: fields.username.trim(), password: fields.password, remember: fields.remember })
}

// The server text wins when it has one; a 429 always shows the retry-after copy.
export function signInErrorText(err: unknown): string {
  if (err instanceof SignInFormError) return err.message
  if (!(err instanceof AdminApiError)) return 'Sign-in failed. Try again in a moment.'
  if (err.status === 429) {
    return err.retryAfterSec
      ? `Too many attempts. Try again in about ${err.retryAfterSec} s.`
      : 'Too many attempts. Wait a moment before retrying.'
  }
  const serverText = err.message
  const generic = !serverText || serverText.startsWith('Request failed')
  const fallback: Record<number, string> = {
    400: 'Blocked by the proxy configuration. Check TRUST_PROXY_HOPS and TRUSTED_PROXY_CIDRS.',
    401: 'Username or password is incorrect.',
    403: 'Sign-in refused here: plain HTTP from this network is not allowed, or this instance is a read-only replica.',
  }
  return (generic ? fallback[err.status] : undefined) ?? (serverText || 'Sign-in failed. Try again in a moment.')
}
