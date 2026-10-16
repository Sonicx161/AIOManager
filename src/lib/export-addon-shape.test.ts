import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// Sync exports strip the embedded manifest (the envelope's manifests map is the
// deduplicated source the import rehydrates from); manual backups keep it
// embedded so they stay self-contained. Source-level guard: both halves of the
// contract must exist together — strip on export, rehydrate on import — because
// removing either half silently breaks cross-device restores.

const src = readFileSync(new URL('../store/account/accountImportExport.ts', import.meta.url), 'utf8')

test('sync exports strip embedded manifests; the manifests map is the rehydration source', () => {
    assert.match(src, /\.\.\.\(forSync \? \{\} : \{ manifest: sanitized \}\)/)
    assert.match(src, /ad\.manifest \|\| manifestMap\[ad\.manifestId as string\]/)
})

test('both wire shapes keep the rehydration key and the flags', () => {
    assert.match(src, /manifestId: key/)
    assert.match(src, /flags: exportAddon\.flags/)
})
