export const CREDENTIALS_INCORRECT = 'The UUID or password is incorrect. Check both and try again.'

// The server answers an unknown UUID and a wrong password with the same 401.
export function signInErrorMessage(raw: string): string {
    return /^Incorrect Password\b/i.test(raw.trim()) ? CREDENTIALS_INCORRECT : raw
}

export type SignInField = 'uuid' | 'password'

export function firstMissingSignInField(uuid: string, password: string): SignInField | null {
    if (!uuid.trim()) return 'uuid'
    if (!password) return 'password'
    return null
}
