import { readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = fileURLToPath(new URL('../', import.meta.url))
function testsIn(dir) {
    return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
        const path = join(dir, entry.name)
        return entry.isDirectory() ? testsIn(path) : entry.name.endsWith('.test.ts') ? [path] : []
    })
}
// Enumerate explicitly so Windows and Node 22 run the same set without shell globbing.
const tests = process.argv.slice(2)
const result = spawnSync(process.execPath, [
    '--import', './scripts/client-test-register.mjs', '--experimental-transform-types', '--test',
    ...(tests.length ? tests.map(path => resolve(path)) : testsIn(join(root, 'src')).sort()),
], { cwd: root, stdio: 'inherit' })
if (result.error) throw result.error
process.exitCode = result.status ?? 1
