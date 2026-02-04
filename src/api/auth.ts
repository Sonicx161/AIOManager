import { stremioClient, LoginResponse } from './stremio-client'

export async function loginWithCredentials(
  email: string,
  password: string
): Promise<LoginResponse> {
  return stremioClient.login(email, password)
}

export async function validateAuthKey(authKey: string): Promise<boolean> {
  try {
    await stremioClient.getAddonCollection(authKey, 'New-Login-Check')
    return true
  } catch {
    return false
  }
}

export async function registerAccount(
  email: string,
  password: string
): Promise<LoginResponse> {
  return stremioClient.register(email, password)
}
