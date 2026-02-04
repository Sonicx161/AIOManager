import { stremioClient, LoginResponse } from './stremio-client'

export async function loginWithCredentials(
  email: string,
  password: string
): Promise<LoginResponse> {
  return stremioClient.login(email, password)
}

export async function validateAuthKey(authKey: string): Promise<boolean> {
  try {
    await stremioClient.getAddonCollection(authKey)
    return true
  } catch {
    return false
  }
}
