import { useFailoverStore } from "@/store/failoverStore"
import { normalizeAddonUrl } from "@/lib/utils"

/**
 * AutopilotManager
 * Coordinates between manual user actions and automatic failover logic.
 */
class AutopilotManager {
    /**
     * Called when a user manually toggles an addon's enabled state.
     * If that addon is part of an active Autopilot rule, we may need to 
     * disable automatic mode to respect the user's manual choice.
     */
    handleManualToggle(accountId: string, transportUrl: string) {
        const { rules, updateRule } = useFailoverStore.getState()
        const normalizedUrl = normalizeAddonUrl(transportUrl).toLowerCase()

        // Find any active rule for this account that includes this addon
        const activeRules = rules.filter(r => r.accountId === accountId && r.isActive)

        for (const rule of activeRules) {
            const chain = rule.priorityChain || []
            const normalizedChain = chain.map((u: string) => normalizeAddonUrl(u).toLowerCase())

            if (normalizedChain.includes(normalizedUrl)) {
                // The user is manually messing with a chain that is under Autopilot control.

                console.log(`[Autopilot] Manual override detected for rule ${rule.id}. Disabling automatic mode and deactivating rule.`)

                updateRule(rule.id, {
                    isActive: false,
                    isAutomatic: false
                })
            }
        }
    }

    /**
     * Check if Autopilot is allowed to make a change.
     */
    canAutomate(ruleId: string): boolean {
        const rule = useFailoverStore.getState().rules.find(r => r.id === ruleId)
        if (!rule) return false

        return rule.isActive && (rule.isAutomatic !== false)
    }
}

export const autopilotManager = new AutopilotManager()
