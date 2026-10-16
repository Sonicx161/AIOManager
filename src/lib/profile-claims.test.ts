import test from 'node:test'
import assert from 'node:assert/strict'
import { getProfileClaims, resolveProfileState, profileClaimKey, loginScope } from './profile-claims.ts'
import type { Account } from '@/types/account'

// Two different Nuvio logins (DoodleBob family + a separate Family Account) can
// have profiles at the same numeric index. Claims must be scoped per login:
// Family's slot 2 (Mom) must never resolve to the Shy account that claimed
// DoodleBob's slot 2 (SHY).

const conn = (email: string, profileId: string) => ({
    id: `conn-${email}-${profileId}`,
    platform: 'nuvio',
    credentials: { email, password: 'pw', baseUrl: '', profileId },
})

const acct = (id: string, name: string, email: string, conns: unknown[]): Account => ({
    id,
    name,
    email,
    connections: conns,
} as unknown as Account)

const doodleBob = acct('acct-doodle', 'Main - DoodleBob Family', 'doodle@family.test', [
    conn('doodle@family.test', '1'),
])
const shy = acct('acct-shy', 'Shy', 'doodle@family.test', [
    conn('doodle@family.test', '2'),
])
const family = acct('acct-family', 'Family Account', 'family@other.test', [
    conn('family@other.test', '2'),
])

test('profile claims from different Nuvio logins never collide at the same index', () => {
    const claims = getProfileClaims([doodleBob, shy, family])
    const doodleKey = profileClaimKey({ platform: 'nuvio', profileId: '2', loginId: loginScope({ email: 'doodle@family.test' }) })
    const familyKey = profileClaimKey({ platform: 'nuvio', profileId: '2', loginId: loginScope({ email: 'family@other.test' }) })
    assert.notEqual(doodleKey, familyKey, 'same index on different logins must produce different keys')
    assert.ok(claims.has(doodleKey), 'Shy claim present for the DoodleBob login')
    assert.ok(!claims.has(familyKey) || claims.get(familyKey)?.accountId === family.id, 'Family login scoped separately')
})

test("Family Account's Mom is its own active-here claim - never Shy's", () => {
    const claims = getProfileClaims([family, shy, doodleBob])
    const state = resolveProfileState({ platform: 'nuvio', profileId: '2', loginId: loginScope({ email: 'family@other.test' }) }, claims, family.id, undefined)
    assert.equal(state, 'active-here')
    const claim = claims.get(profileClaimKey({ platform: 'nuvio', profileId: '2', loginId: loginScope({ email: 'family@other.test' }) }))
    assert.equal(claim?.accountId, family.id, 'the claim on this login belongs to Family, not Shy')
})

test("DoodleBob's SHY row still resolves to the Shy account (parent login scope)", () => {
    const claims = getProfileClaims([doodleBob, shy])
    const state = resolveProfileState({ platform: 'nuvio', profileId: '2', loginId: loginScope({ email: 'doodle@family.test' }) }, claims, doodleBob.id, undefined)
    assert.equal(state, 'claimed')
    const claim = claims.get(profileClaimKey({ platform: 'nuvio', profileId: '2', loginId: loginScope({ email: 'doodle@family.test' }) }))
    assert.equal(claim?.accountName, 'Shy')
})

test('derived profile accounts share the parent login scope', () => {
    const parentScope = loginScope({ email: 'doodle@family.test' })
    const derivedScope = loginScope({ email: 'doodle@family.test', profileId: '2' })
    assert.equal(parentScope, derivedScope, 'extra fields must not change the login scope')
})
