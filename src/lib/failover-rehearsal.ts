import {
    CHECK_INTERVAL_MS, FAILOVER_THRESHOLD, RECOVERY_THRESHOLD, TRANSITION_MESSAGES, decideTarget, resolveMessageTemplate,
    type DecisionMember,
} from '../../server/autopilot/v1/failover-decision.js'
import type { Account } from '../types/account'
import { isAddonConnection, type Connection } from '../types/connection.ts'
import { isAddonExcludedFrom } from './addon-destinations.ts'
import { getStremioConnection } from './account-compat.ts'
import { normalizeAddonUrl } from './addon-url.ts'

const minutesFor = (checks: number) => Math.max(1, Math.round((checks * CHECK_INTERVAL_MS) / 60000))

export const failoverTiming = {
    missedChecks: FAILOVER_THRESHOLD,
    goodChecks: RECOVERY_THRESHOLD,
    switchMinutes: minutesFor(FAILOVER_THRESHOLD),
    backMinutes: minutesFor(RECOVERY_THRESHOLD),
    intervalSeconds: Math.round(CHECK_INTERVAL_MS / 1000),
}

export function failoverTimingText(): string {
    const t = failoverTiming
    return `Switches to the next addon after ${t.missedChecks} missed checks in a row (about ${t.switchMinutes} min). Switches back after ${t.goodChecks} good checks (about ${t.backMinutes} min).`
}

export function checkCadenceText(): string {
    const s = failoverTiming.intervalSeconds
    return s === 60 ? 'every minute' : `every ${s} seconds`
}

function spanLabel(ms: number): string {
    const minutes = Math.round(ms / 60000)
    if (minutes < 1) return 'under a minute'
    if (minutes < 60) return `${minutes} min`
    const hours = Math.round(minutes / 60)
    if (hours < 48) return `${hours} h`
    return `${Math.round(hours / 24)} days`
}

export function agoLabel(ms: number): string {
    return ms < 45_000 ? 'just now' : `${spanLabel(ms)} ago`
}

export interface SwitchLogLike {
    type: string
    ruleId: string
    timestamp: Date
}

/** The newest failover for a rule and, when one followed it, how long until the switch back. */
export function lastSwitchText(logs: SwitchLogLike[], ruleId: string, now: number): string {
    const own = logs.filter(log => log.ruleId === ruleId)
    const failover = own.filter(log => log.type === 'failover').sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())[0]
    if (!failover) return 'No switches recorded yet.'
    const at = failover.timestamp.getTime()
    const back = own.filter(log => log.type === 'recovery' && log.timestamp.getTime() > at).sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())[0]
    const ago = `${spanLabel(Math.max(0, now - at))} ago`
    return back
        ? `Last switch: ${ago}, back ${spanLabel(back.timestamp.getTime() - at)} later.`
        : `Last switch: ${ago}, still on backup.`
}

export interface RehearsalTier {
    url: string
    name: string
    healthy: boolean
}

export type RehearsalKind = 'switch' | 'recover' | 'stay' | 'outage'

export interface RehearsalResult {
    kind: RehearsalKind
    activeIndex: number
    targetIndex: number
    pretendIndex: number
    notificationType: 'failover' | 'recovery'
}

// Checked members become the steady state the engine would reach: healthy is UP with a full streak,
// down (or pretended down) is DOWN after the failover threshold. The engine's own decideTarget then picks.
export function rehearseFailover({ tiers, activeIndex, pretendIndex }: { tiers: RehearsalTier[]; activeIndex: number; pretendIndex: number }): RehearsalResult {
    const members: DecisionMember[] = tiers.map((tier, i) => (tier.healthy && i !== pretendIndex
        ? { state: 'UP', goodStreak: RECOVERY_THRESHOLD, badStreak: 0 }
        : { state: 'DOWN', goodStreak: 0, badStreak: FAILOVER_THRESHOLD }))
    const decision = decideTarget(members, activeIndex)
    let kind: RehearsalKind
    if (decision.targetIndex === -1) kind = decision.reason === 'outage' ? 'outage' : 'stay'
    else if (decision.targetIndex === activeIndex) kind = 'stay'
    else kind = decision.reason === 'recovered' ? 'recover' : 'switch'
    return {
        kind,
        activeIndex,
        targetIndex: decision.targetIndex,
        pretendIndex,
        notificationType: decision.targetIndex === 0 ? 'recovery' : 'failover',
    }
}

export interface RehearsalPlatform {
    platformId: string
    logins: number
    needsLogin: boolean
    excluded: boolean
}

const BAD_STATUS = new Set(['expired', 'error'])

export interface RehearsalRuleScope {
    connectionId?: string
    platform?: string
}

// The logins the engine writes to: one Stremio target carrying the rule's auth key (the engine's single
// synthetic stremio write, never the account's other native Stremio logins), plus the account's enabled
// non-Stremio addon connections, narrowed to one when the rule is bound to a non-Stremio connection
// (the engine's hasConnectionTarget).
export function rehearsalConnections(account: Account, rule: RehearsalRuleScope): Connection[] {
    const others = (account.connections || []).filter(c => c.enabled && c.connectionType !== 'hydra-inbound' && isAddonConnection(c) && c.platform !== 'stremio')
    const stremio = getStremioConnection(account)
    const all: Connection[] = stremio ? [stremio as Connection, ...others] : others
    const bound = !!rule.connectionId && !!rule.platform && rule.platform !== 'stremio'
    return bound ? all.filter(c => c.id === rule.connectionId) : all
}

export function rehearsalPlatforms(account: Account, rule: RehearsalRuleScope, targetUrl: string): RehearsalPlatform[] {
    const target = account.addons.find(addon => normalizeAddonUrl(addon.transportUrl) === normalizeAddonUrl(targetUrl))
    const groups = new Map<string, Connection[]>()
    for (const connection of rehearsalConnections(account, rule)) {
        groups.set(connection.platform, [...(groups.get(connection.platform) || []), connection])
    }
    const order = (platform: string) => (platform === 'stremio' ? 0 : 1)
    return [...groups.entries()]
        .sort((a, b) => order(a[0]) - order(b[0]))
        .map(([platformId, logins]) => ({
            platformId,
            logins: logins.length,
            needsLogin: logins.some(c => BAD_STATUS.has(c.status)),
            excluded: !!target && logins.every(c => isAddonExcludedFrom(target, { platform: c.platform, connectionId: c.id })),
        }))
}

export interface RehearsalNotification {
    title: string
    message: string
}

// Same wording and template tokens as the engine. The engine fills the name tokens with addon URLs, so this does too.
export function rehearsalNotification({ type, template, accountName, ruleName, fromUrl, targetUrl }: {
    type: 'failover' | 'recovery'
    template?: string
    accountName: string
    ruleName?: string
    fromUrl: string
    targetUrl: string
}): RehearsalNotification {
    const message = resolveMessageTemplate(template || null, {
        type,
        message: TRANSITION_MESSAGES[type],
        accountName,
        ruleName,
        fromName: fromUrl,
        activeName: targetUrl,
    }) || TRANSITION_MESSAGES[type]
    return { title: `Autopilot: ${type}`, message }
}
