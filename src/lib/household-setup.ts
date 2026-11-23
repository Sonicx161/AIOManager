import { buildAIOStreamsVariantInstallUrl } from './aiostreams-variant-url.ts'
import { addProfile, alignProfilesForReadback, assertProfilesKept, listProfiles, ownerDisplayName, updateProfile, OWNER_PROFILE_ID } from './aiostreams-profiles.ts'

export type HouseholdConfig = Record<string, unknown>
type RecordValue = Record<string, unknown>

export interface HouseholdSetupInput {
    destination: HouseholdConfig
    effectiveDestination?: HouseholdConfig
    metadata?: HouseholdConfig
    personName: string
    variant?: { name: string; script: string }
    memberId?: string
    metadataMemberId?: string
    installUrl: string
    maxScriptLength?: number
    maxVariants?: number
    maxPersonas?: number
    variantsAvailable?: boolean
    reservedVariantIds?: string[]
}

export interface HouseholdSetupPlan {
    variantId?: string
    variantName?: string
    variantScript?: string
    playbackVariantIds: string[]
    playbackUrl: string
    personName: string
    memberId: string
    memberKind: 'primary' | 'persona'
    memberName: string
    metadataMemberId?: string
    metadataMemberName?: string
    aiostreams: { before: HouseholdConfig; after: HouseholdConfig; effectiveBefore?: HouseholdConfig }
    aiometadata?: { before: HouseholdConfig; after: HouseholdConfig }
}

export const configRecords = (value: unknown): RecordValue[] => Array.isArray(value)
    ? value.filter((item): item is RecordValue => !!item && typeof item === 'object' && !Array.isArray(item))
    : []

const record = (value: unknown): RecordValue => value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {}
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
const sameName = (a: unknown, b: string) => typeof a === 'string' && a.trim().toLowerCase() === b.trim().toLowerCase()
const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 25) || 'person'

function newId(name: string, used: Set<string>): string {
    const base = slug(name)
    let candidate = base
    for (let suffix = 2; used.has(candidate); suffix++) candidate = `${base}-${suffix}`
    if (candidate.length > 32) throw new Error('Choose a shorter name for this person.')
    return candidate
}

export function readHouseholdCapabilities(status: HouseholdConfig | null, destination: HouseholdConfig): {
    maxPersonas: number; maxScriptLength?: number; maxVariants?: number
    variantsAvailable: boolean; variantUnavailableReason?: string
} {
    if (!status) throw new Error('Could not load the AIOStreams instance capabilities. Wait a moment and load again.')
    const settings = record(status?.settings)
    const variants = record(settings.variants)
    const jellyfin = record(settings.jellyfin)
    if (jellyfin.enabled !== true) throw new Error('This AIOStreams instance does not advertise household users. Enable Jellyfin support or update the instance, then load again.')
    const limit = jellyfin.maxProfiles ?? jellyfin.maxPersonas
    if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 0) {
        throw new Error('This AIOStreams instance did not report its household user limit. Update the instance, then load again.')
    }
    const result = { maxPersonas: limit, variantsAvailable: false }
    if (!['all', 'trusted'].includes(String(variants.access))) return { ...result, variantUnavailableReason: 'Variants are disabled on this instance.' }
    if (variants.access === 'trusted' && destination.trusted !== true) return { ...result, variantUnavailableReason: 'This instance limits variants to trusted configurations.' }
    if (![variants.maxScriptLength, variants.max].every(value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)) {
        return { ...result, variantUnavailableReason: 'This instance did not report usable variant limits.' }
    }
    return { ...result, variantsAvailable: true, maxScriptLength: variants.maxScriptLength as number, maxVariants: variants.max as number }
}

export function householdVariantInstallUrl(installUrl: string, variantIds: string | string[] | null): string {
    const url = new URL(installUrl.replace(/^stremio:\/\//i, 'https://'))
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !/\/manifest\.json$/i.test(url.pathname)) {
        throw new Error('Choose a valid AIOStreams addon installation.')
    }
    url.hash = ''
    const selected = buildAIOStreamsVariantInstallUrl(url.toString(), variantIds)
    if (!selected) throw new Error('Choose a valid AIOStreams addon installation.')
    return selected
}

export function buildHouseholdSetupPlan(input: HouseholdSetupInput): HouseholdSetupPlan {
    const name = input.personName.trim()
    if (!name || name.length > 32) throw new Error('Enter a person name between 1 and 32 characters.')
    const destination = structuredClone(input.destination)
    let variantId: string | undefined
    if (input.variant) {
        if (input.variantsAvailable === false) throw new Error('Variants are unavailable for this configuration. Continue with user setup only.')
        const variantName = input.variant.name.trim()
        if (!variantName || variantName.length > 64) throw new Error('Enter a variant name between 1 and 64 characters.')
        if (!input.variant.script.trim()) throw new Error('Enter CEL rules for the variant, or turn off variant creation.')
        if (input.variant.script.length > (input.maxScriptLength ?? 4000)) throw new Error('These rules exceed the instance’s variant size limit. Shorten the script before continuing.')
        const variants = configRecords(destination.variants)
        const reservedIds = new Set([...variants.map(v => String(v.id)), ...(input.reservedVariantIds || [])].map(id => id.toLowerCase()))
        if (input.maxVariants !== undefined && reservedIds.size >= input.maxVariants) throw new Error('This configuration has reached the instance’s variant limit. Continue with user setup only, or remove an unused variant.')
        variantId = newId(variantName, reservedIds)
        destination.variants = [...variants, { id: variantId, name: variantName, enabled: true, script: input.variant.script }]
    }
    const before = destination
    const addVariant = (entry: RecordValue) => ({ ...entry, variants: [...new Set([...strings(entry.variants), variantId!])] })
    const others = listProfiles(destination).profiles.filter(p => !p.owner)
    let memberId: string
    let after: HouseholdConfig
    let memberName: string
    let playbackVariantIds: string[]
    if (input.memberId === '@primary') {
        memberId = 'primary'
        memberName = ownerDisplayName(destination)
        if (!memberName) throw new Error('The primary user has no configured name. Select an existing household user or create a separate user.')
        after = variantId ? updateProfile(destination, OWNER_PROFILE_ID, addVariant) : destination
        assertProfilesKept(before, after, [OWNER_PROFILE_ID])
        playbackVariantIds = [...new Set(listProfiles(after).profiles.find(p => p.owner)?.variants ?? [])]
    } else if (input.memberId) {
        const member = others.find(p => p.id === input.memberId)
        if (!member) throw new Error('The selected AIOStreams user no longer exists. Load the config again.')
        memberId = member.id
        after = variantId ? updateProfile(destination, memberId, addVariant) : destination
        assertProfilesKept(before, after, [memberId])
        const updated = listProfiles(after).profiles.find(p => !p.owner && p.id === memberId)!
        memberName = updated.name || name
        playbackVariantIds = [...new Set(updated.variants ?? [])]
    } else {
        if (input.maxPersonas !== undefined && others.length >= input.maxPersonas) throw new Error('This configuration has reached the instance’s household user limit. Select an existing user instead.')
        const ownerName = listProfiles(destination).profiles.find(p => p.owner)?.name
        if (others.some(p => sameName(p.name, name)) || sameName(ownerName, name)) {
            throw new Error('An AIOStreams user already has this name. Select that existing user.')
        }
        memberId = newId(name, new Set(others.map(p => p.id)))
        after = addProfile(destination, { id: memberId, name, variants: variantId ? [variantId] : [], history: 'own', trackers: [] })
        assertProfilesKept(before, after, [memberId, OWNER_PROFILE_ID])
        memberName = name
        playbackVariantIds = variantId ? [variantId] : []
    }
    const plan: HouseholdSetupPlan = {
        ...(variantId && input.variant ? { variantId, variantName: input.variant.name.trim(), variantScript: input.variant.script } : {}),
        playbackVariantIds, playbackUrl: householdVariantInstallUrl(input.installUrl, playbackVariantIds),
        memberId, memberKind: input.memberId === '@primary' ? 'primary' : 'persona', personName: name,
        memberName,
        aiostreams: { before: structuredClone(input.destination), after,
            ...(input.effectiveDestination ? { effectiveBefore: structuredClone(input.effectiveDestination) } : {}) },
    }
    if (input.metadata) {
        const metadata = structuredClone(input.metadata)
        const users = configRecords(metadata.jellyfinUsers)
        let user = input.metadataMemberId ? users.find(p => p.id === input.metadataMemberId) : undefined
        if (input.metadataMemberId && !user) throw new Error('The selected AIOMetadata user no longer exists. Load the config again.')
        if (!user && users.some(p => sameName(p.name, name))) throw new Error('An AIOMetadata user already has this name. Select that existing user.')
        const handoffName = memberName
        if (users.some(p => p.id !== user?.id && (sameName(p.name, handoffName) || strings(p.handoffNames).some(n => sameName(n, handoffName))))) {
            throw new Error('That handoff name is assigned to another AIOMetadata user. Choose the matching user.')
        }
        const metadataMemberId = user ? String(user.id) : newId(name, new Set(users.map(p => String(p.id))))
        user = { ...(user || { id: metadataMemberId, name, tags: [], trackers: false, trackerSource: 'off' }),
            streamUrl: plan.playbackUrl,
            handoffNames: [...new Set([...strings(user?.handoffNames), handoffName])],
        }
        metadata.jellyfinUsers = input.metadataMemberId ? users.map(p => p.id === metadataMemberId ? user! : p) : [...users, user]
        plan.metadataMemberId = metadataMemberId
        plan.metadataMemberName = String(user.name)
        plan.aiometadata = { before: structuredClone(input.metadata), after: metadata }
    }
    return plan
}

const RUNTIME_FIELDS = new Set(['uuid', 'encryptedPassword', 'trusted', 'ip', 'accessToken', 'sessionId', 'configHash', 'configVersion', 'lastModified', 'accessKey', 'activeVariants', 'autoVariants', 'healthResults', 'variantSelectorLocation', 'showChanges'])
function canonical(value: unknown): string {
    function sort(item: unknown): unknown {
        if (Array.isArray(item)) return item.map(sort)
        if (!item || typeof item !== 'object') return item
        return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, sort(v)]))
    }
    return JSON.stringify(sort(value))
}
function comparable(config: HouseholdConfig): HouseholdConfig {
    return Object.fromEntries(Object.entries(config).filter(([key]) => !RUNTIME_FIELDS.has(key)))
}
function contains(actual: unknown, expected: unknown): boolean {
    if (Array.isArray(expected)) return Array.isArray(actual) && expected.every((entry, index) => contains(actual[index], entry)) && actual.length === expected.length
    if (expected && typeof expected === 'object') return !!actual && typeof actual === 'object'
        && Object.entries(expected).every(([key, value]) => contains((actual as RecordValue)[key], value))
    return actual === expected
}

function readbackPair(actual: HouseholdConfig, expected: HouseholdConfig): [HouseholdConfig, HouseholdConfig] {
    const aligned = alignProfilesForReadback(expected, actual)
    return [aligned.readback, aligned.planned]
}

export interface HouseholdServiceAdapter {
    load: () => Promise<HouseholdConfig>
    loadEffective?: () => Promise<HouseholdConfig>
    save: (next: HouseholdConfig, base: HouseholdConfig) => Promise<void>
}
export interface HouseholdStageResult {
    service: 'aiostreams' | 'aiometadata'
    status: 'saving' | 'verified' | 'failed'
    message?: string
}

export async function applyHouseholdSetupPlan(
    plan: HouseholdSetupPlan,
    adapters: { aiostreams: HouseholdServiceAdapter; aiometadata?: HouseholdServiceAdapter },
    onProgress: (result: HouseholdStageResult) => void = () => {},
): Promise<HouseholdStageResult[]> {
    const results: HouseholdStageResult[] = []
    const stages: Array<'aiostreams' | 'aiometadata'> = plan.aiometadata ? ['aiostreams', 'aiometadata'] : ['aiostreams']
    for (const service of stages) {
        const stage = plan[service]
        const adapter = adapters[service]
        if (!stage || !adapter) throw new Error('A service connection is missing. Load the preview again.')
        // Confirm destination-owned credentials, parent linkage and unknown fields too.
        // A saved user is not a verified setup if collateral settings disappeared.
        const expected = comparable(stage.after)
        const progress = { service, status: 'saving' } as HouseholdStageResult
        onProgress(progress)
        try {
            const current = await adapter.load()
            const confirms = (actual: HouseholdConfig) => service === 'aiostreams'
                ? contains(...readbackPair(actual, expected)) : contains(actual, expected)
            // A retry verifies the already-saved step rather than creating a second user.
            if (!confirms(current)) {
                if (canonical(comparable(current)) !== canonical(comparable(stage.before))) throw new Error('This configuration changed after preview. Load it again and review your choices.')
                if (service === 'aiostreams' && plan.aiostreams.effectiveBefore) {
                    if (!adapter.loadEffective) throw new Error('Reload the effective destination configuration before saving this setup.')
                    const effective = await adapter.loadEffective()
                    const userBasis = (config: HouseholdConfig) => ({ jellyfin: config.jellyfin, profiles: config.profiles, variants: config.variants })
                    if (canonical(userBasis(effective)) !== canonical(userBasis(plan.aiostreams.effectiveBefore))) {
                        throw new Error('The shared users or variants changed after preview. Load it again and review your choices.')
                    }
                }
                await adapter.save(stage.after, current)
                if (!confirms(await adapter.load())) throw new Error('The server did not confirm the requested setup settings. Review this service before retrying.')
            }
            const result = { service, status: 'verified' } as HouseholdStageResult
            results.push(result); onProgress(result)
        } catch (error) {
            const result = { service, status: 'failed', message: error instanceof Error ? error.message : 'The service could not be verified.' } as HouseholdStageResult
            results.push(result); onProgress(result)
            break
        }
    }
    return results
}
