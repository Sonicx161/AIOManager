import { autopilotDb as db } from '../write-tripwire.js'
import { enqueueProxyRequest } from '../../proxy-queue.js'
import { isSafeUrl } from '../../utils/ssrf.js'
import { guardedFetch } from '../../utils/safe-fetch.js'
import { maskContext } from '../../utils/log-helpers.js'
import { getGlobalWebhook } from '../global-webhook.js'
import { urlRef, scrubUrls } from './url-ref.js'
import { assertAccountActive, gateCode } from '../../admin/account-state.js'

// Connect-time guarded POST on the shared keep-alive agents; the reply body is never read.
export const guardedWebhookFetch = (url, { method = 'POST', headers, body, signal } = {}) =>
    guardedFetch(String(url), { method, headers, body, signal, redirect: 'manual', maxHops: 0, discardBody: true, connectTimeoutMs: 5000, totalTimeoutMs: 10000 })

export function createNotify({ fastify, nowMs, fetchImpl = guardedWebhookFetch, decryptRuleField }) {
    const resolveMessageTemplate = (template, payload) => {
        if (!template) return payload.message
        const values = {
            account: payload.accountName || payload.accountId || 'Unknown',
            rule: payload.ruleName || 'Unnamed Rule',
            primary: payload.fromName || payload.fromUrl || 'Unknown',
            backup: payload.activeName || payload.activeUrl || 'Unknown',
            addon: payload.activeName || 'Unknown',
            from: payload.fromName || payload.fromUrl || 'Unknown',
            to: payload.activeName || payload.activeUrl || 'Unknown',
            status: payload.type === 'failover' ? 'Failed Over' : payload.type === 'recovery' ? 'Recovered' : payload.type,
            provider: payload.provider || 'Unknown',
        }
        return template.replace(/\{{1,2}\s*(account|rule|primary|backup|addon|from|to|status|provider)\s*\}{1,2}/gi, (match, key) => {
            const value = values[key.toLowerCase()]
            return value !== undefined ? value : match
        })
    }

    // Returns true when the notification was enqueued, false when it was refused.
    // Every caller must name the owner: a webhook without an owner would skip the
    // account-state gate entirely, so it is refused instead of sent unguarded.
    const sendNotification = async (webhookUrl, payload) => {
        if (!webhookUrl || !webhookUrl.startsWith('http')) return false
        if (!payload?.owner) return false
        if (!isSafeUrl(webhookUrl)) return false
        // Final account-state check before the enqueue: a blocked owner sends nothing.
        // Notifications already queued before a block may still deliver.
        try {
            await assertAccountActive(payload.owner)
        } catch (stateErr) {
            if (gateCode(stateErr)) return false
            throw stateErr
        }

        await enqueueProxyRequest(webhookUrl, async () => {
            try {
                const message = resolveMessageTemplate(payload.messageTemplate, payload)
                let body

                if (webhookUrl.includes('discord.com/api/webhooks/')) {
                    body = {
                        username: 'AIOManager Autopilot',
                        avatar_url: 'https://raw.githubusercontent.com/Sonicx161/AIOManager/main/public/logo.png',
                        content: payload.discordMention || undefined,
                        embeds: [{
                            color: payload.type === 'failover' ? 0xff9900 : (payload.type === 'recovery' ? 0x00cc66 : payload.type === 'debrid_down' ? 0xff3333 : 0x3b82f6),
                            title: payload.type === 'failover' ? '⚠️ Failover Triggered' : (payload.type === 'recovery' ? '✅ Recovery' : payload.type === 'debrid_down' ? '🔑 Debrid Provider Down' : '📡 Notification'),
                            description: message,
                            fields: payload.type === 'debrid_down'
                                ? [{ name: 'Provider', value: payload.provider || 'Unknown', inline: true }]
                                : [
                                    { name: 'Account', value: payload.accountName || payload.accountId || 'Unknown', inline: true },
                                    { name: 'Active Addon', value: payload.activeName || 'Unknown', inline: true }
                                ],
                            timestamp: new Date(nowMs()).toISOString()
                        }]
                    }
                } else if (webhookUrl.includes('hooks.slack.com/')) {
                    const emoji = payload.type === 'failover' ? '⚠️' : (payload.type === 'recovery' ? '✅' : payload.type === 'debrid_down' ? '🔑' : '📡')
                    body = {
                        text: `${emoji} *AIOManager Autopilot*\n${message}`,
                        attachments: [{
                            color: payload.type === 'failover' ? 'warning' : (payload.type === 'recovery' ? 'good' : payload.type === 'debrid_down' ? 'danger' : '#3b82f6'),
                            fields: payload.type === 'debrid_down'
                                ? [{ title: 'Provider', value: payload.provider || 'Unknown', short: true }]
                                : [
                                    { title: 'Account', value: payload.accountName || payload.accountId || 'Unknown', short: true },
                                    { title: 'Active Addon', value: payload.activeName || 'Unknown', short: true }
                                ],
                            footer: 'AIOManager Autopilot',
                            ts: Math.floor(nowMs() / 1000)
                        }]
                    }
                } else {
                    body = {
                        source: 'AIOManager Autopilot',
                        type: payload.type,
                        message,
                        accountName: payload.accountName || payload.accountId || 'Unknown',
                        activeName: payload.activeName || 'Unknown',
                        provider: payload.provider || undefined,
                        timestamp: new Date(nowMs()).toISOString()
                    }
                }

                const webhookRes = await fetchImpl(webhookUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
                    redirect: 'manual'
                })
                if (!webhookRes.ok) {
                    fastify.log.warn({ category: 'Autopilot' }, `Webhook ${urlRef(webhookUrl, 'wh')} returned status ${webhookRes.status}`)
                }
            } catch (err) {
                fastify.log.error({ category: 'Autopilot' }, `Webhook failed for ${urlRef(webhookUrl, 'wh')}: ${scrubUrls(err?.message)}`)
            }
        })
        return true
    }

    // Only a firing notification needs the name; scoped by the rule's owner like every credential read.
    const lookupAccountName = async (accountId, syncUser) => {
        try {
            const row = await db.get(
                `SELECT account_name FROM server_credentials
                 WHERE account_id = $1 AND sync_user = $2 AND account_name <> ''
                 ORDER BY updated_at DESC LIMIT 1`,
                [accountId, syncUser || '']
            )
            return row?.account_name || null
        } catch (err) {
            fastify.log.warn({ category: 'Autopilot' }, `[${maskContext(accountId)}] Account name lookup failed: ${err.message}`)
            return null
        }
    }

    // Cooldown gate and rule -> global webhook resolution; true when a notification was sent.
    const notifyTransition = async (rule, { type, msg, chain, targetActiveUrl }) => {
        let sent = false
        const now = nowMs()
        const lastNotification = rule.last_notification || 0
        const cooldownMs = rule.cooldown_ms || (10 * 60 * 1000)

        // Per-rule "notifications off" (saved by the client, never written per cycle)
        // silences this rule even when a global webhook exists. NULL/undefined = enabled.
        if (rule.notify_enabled === 0) {
            fastify.log.info({ category: 'Autopilot' }, `[${maskContext(rule.account_id)}] Notifications off for rule ${rule.id}. Skipping notification.`)
            return sent
        }

        const isRecovery = type === 'recovery'
        const cooldownPassed = now - lastNotification >= cooldownMs

        if (isRecovery || cooldownPassed) {
            // Resolution order: decrypted per-rule webhook -> owner's global
            // webhook (the UI's "Use global webhook" default) -> none.
            let webhookUrl = rule.webhook_url ? decryptRuleField(rule, 'webhook_url') : null
            let webhookSource = 'rule'
            if (rule.webhook_url && !webhookUrl) {
                fastify.log.warn({ category: 'Autopilot' }, `[${maskContext(rule.account_id)}] Per-rule webhook blob present but undecryptable; falling back to the global webhook.`)
            }
            if (!webhookUrl) {
                webhookUrl = await getGlobalWebhook(rule.owner_sync_user)
                webhookSource = 'global'
            }
            if (!webhookUrl) {
                fastify.log.info({ category: 'Autopilot' }, `[${maskContext(rule.account_id)}] No webhook configured (rule + global). Skipping notification.`)
            } else {
                sent = (await sendNotification(webhookUrl, {
                    type,
                    message: msg,
                    messageTemplate: rule.message_template || null,
                    accountId: rule.account_id,
                    accountName: rule.account_name || await lookupAccountName(rule.account_id, rule.owner_sync_user),
                    ruleName: rule.name || null,
                    activeName: targetActiveUrl,
                    fromName: chain[0],
                    fromUrl: chain[0],
                    owner: rule.owner_sync_user,
                })) === true
                if (sent) fastify.log.info({ category: 'Autopilot' }, `[${maskContext(rule.account_id)}] Webhook sent (${webhookSource}): ${type}`)
            }
        } else {
            fastify.log.debug({ category: 'Autopilot' }, `[${maskContext(rule.account_id)}] Webhook skipped (cooldown: ${Math.round((cooldownMs - (now - lastNotification)) / 1000)}s remaining)`)
        }
        return sent
    }

    return { sendNotification, lookupAccountName, notifyTransition }
}
