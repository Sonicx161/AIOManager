// Node's test runner needs the same local alias and extension resolution as Vite.
// Keep resolution limited to actual files; missing imports still fail normally.
import { registerHooks } from 'node:module'
import { existsSync, statSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolve, extname } from 'node:path'

const sourceRoot = fileURLToPath(new URL('../src/', import.meta.url))

registerHooks({
    resolve(specifier, context, nextResolve) {
        let candidate
        if (specifier.startsWith('@/')) candidate = resolve(sourceRoot, specifier.slice(2))
        else if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) {
            candidate = fileURLToPath(new URL(specifier, context.parentURL))
        }
        if (candidate) {
            const candidates = extname(candidate) ? [candidate] : [candidate, `${candidate}.ts`, `${candidate}.tsx`, `${candidate}.js`, resolve(candidate, 'index.ts')]
            const file = candidates.find(path => existsSync(path) && statSync(path).isFile())
            if (file) return nextResolve(pathToFileURL(file).href, context)
        }
        return nextResolve(specifier, context)
    },
})
