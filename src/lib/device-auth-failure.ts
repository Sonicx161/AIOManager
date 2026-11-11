import { isTerminalAuthReason } from './device-store.ts'

export type DeviceAuthFailureOutcome = 'ignore' | 'discard-record' | 'wipe-session'

export function resolveDeviceAuthFailureOutcome(input: { hasPasswordCredential: boolean; reason: unknown }): DeviceAuthFailureOutcome {
    if (!isTerminalAuthReason(input.reason)) return 'ignore'
    return input.hasPasswordCredential ? 'discard-record' : 'wipe-session'
}
