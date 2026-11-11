export const FAILOVER_THRESHOLD: number
export const RECOVERY_THRESHOLD: number
export const CHECK_INTERVAL_MS: number
export const TRANSITION_MESSAGES: Readonly<{ failover: string; recovery: string }>

export interface DecisionMember {
    state: 'UNKNOWN' | 'UP' | 'FAILING' | 'DOWN' | 'RECOVERING'
    goodStreak: number
    badStreak: number
}

export type DecisionReason = 'active-dead' | 'outage' | 'recovered' | 'active' | null

export function decideTarget(members: DecisionMember[], activeIndex: number): { targetIndex: number; reason: DecisionReason }

export interface NotificationPayload {
    type?: string
    message?: string
    accountName?: string
    accountId?: string
    ruleName?: string
    activeName?: string
    activeUrl?: string
    fromName?: string
    fromUrl?: string
    provider?: string
}

export function resolveMessageTemplate(template: string | null | undefined, payload: NotificationPayload): string | undefined
