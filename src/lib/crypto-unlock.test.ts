import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deriveKeyAndHash, deriveVerifiedKey, hashPassword, deriveKey, generateSalt, encrypt, decrypt } from './crypto.ts'

// The unlock path previously ran the identical PBKDF2 twice (hashPassword then
// deriveKey). The single-pass helpers must be byte-equivalent with the old
// two-pass results or every stored hash and every encrypted artifact breaks.

test('single-pass hash is byte-identical to the legacy two-pass hashPassword output', async () => {
    const salt = generateSalt()
    const legacyHash = await hashPassword('correct horse', salt)
    const { hash } = await deriveKeyAndHash('correct horse', salt)
    assert.equal(hash, legacyHash, 'stored-hash format must not change or existing devices fail to unlock')
})

test('deriveVerifiedKey rejects a wrong password and accepts the right one', async () => {
    const salt = generateSalt()
    const { hash } = await deriveKeyAndHash('correct horse', salt)

    const wrong = await deriveVerifiedKey('wrong pony', salt, hash)
    assert.equal(wrong, null, 'a wrong password must never produce a key')

    const right = await deriveVerifiedKey('correct horse', salt, hash)
    assert.ok(right, 'the right password unlocks')
})

test('the single-pass key is interchangeable with the legacy deriveKey key', async () => {
    const salt = generateSalt()
    const legacyKey = await deriveKey('correct horse', salt)
    const { hash } = await deriveKeyAndHash('correct horse', salt)
    const singlePassKey = await deriveVerifiedKey('correct horse', salt, hash)
    assert.ok(singlePassKey)

    const sealed = await encrypt('vault secret', legacyKey)
    const opened = await decrypt(sealed, singlePassKey!)
    assert.equal(opened, 'vault secret', 'data sealed under the legacy key must open with the single-pass key')
})
