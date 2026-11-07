// Single source of truth for AIOManager server environment configuration.
//
// Every environment variable the server reads is declared here with a zod
// schema (type, default, range) and a human-readable description. All values
// are validated once at boot: wrong types and out-of-range values kill the
// process with a message naming the variable. Unrecognized variables that look
// like typos of known ones produce a one-line warning, never a hard failure,
// because users legitimately carry leftover variables in their environments.
//
// Numeric fields with legacy Math.max clamping behavior (below-min values are
// clamped to min with a console.warn, not fatal) preserve the old behavior:
// IMAGE_PROXY_*, IMAGE_CACHE_*, AIOSTREAMS_USER_API_THROTTLE_MS, and all
// ACTIVITY_*/AUTOPILOT_* vars that were previously clamped in their engine
// files. Values below min clamp to min; values above max remain fatal.
//
// The .env.example at the repo root is generated from this file:
//   npm --prefix server run gen:env
//
// Emergency escape hatch (NOT recommended): SKIP_ENV_VALIDATION=1 boots with
// raw, unvalidated values.

import { createEnv } from '@t3-oss/env-core'
import { FIELDS, ENV_GROUPS, ENV_META, serverSchema, envTopologyProblems } from './env-schema.js'

export { ENV_GROUPS, ENV_META, serverSchema }


// ---------------------------------------------------------------------------
// Validation. Runs once when this module is first imported (i.e. at boot,
// before the server starts listening).
// ---------------------------------------------------------------------------

export const env = createEnv({
    server: serverSchema,
    runtimeEnv: process.env,
    emptyStringAsUndefined: true,
    skipValidation: process.env.SKIP_ENV_VALIDATION === '1',
    onValidationError: (issues) => {
        const lines = issues.map((issue) => {
            const name = Array.isArray(issue.path) ? issue.path.join('.') : String(issue.path)
            const raw = process.env[name]
            // Never echo a value that might be a secret; print its length instead.
            const isSecretish = /KEY|SECRET|TOKEN|PASSWORD|URL|DSN/i.test(name)
            const got = raw === undefined || raw === ''
                ? ''
                : isSecretish ? ` (got value of length ${raw.length})` : ` (got '${raw}')`
            return `  - ${name} ${issue.message}${got}`
        })
        console.error(`Invalid environment:\n${lines.join('\n')}\nFix or unset the variable(s) above, then restart.`)
        process.exit(1)
    },
})

// Topology rules across fields (see env-schema.js); same fatal boot treatment.
if (process.env.SKIP_ENV_VALIDATION !== '1') {
    const topologyProblems = envTopologyProblems(env)
    if (topologyProblems.length) {
        console.error(`Invalid environment:\n${topologyProblems.map((line) => `  - ${line}`).join('\n')}\nFix or unset the variable(s) above, then restart.`)
        process.exit(1)
    }
}

// One-line warning for unrecognized variables that look like typos of known
// ones (edit distance <= 2). Deliberately does not fail the boot: users have
// leftover variables from older versions or other tools.
function editDistance(a, b) {
    const m = a.length
    const n = b.length
    if (Math.abs(m - n) > 2) return 3 // cheap early exit; anything > 2 is ignored anyway
    let prev = Array.from({ length: n + 1 }, (_, j) => j)
    for (let i = 1; i <= m; i++) {
        const cur = [i]
        for (let j = 1; j <= n; j++) {
            cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
        }
        prev = cur
    }
    return prev[n]
}

function warnOnSuspiciousUnknowns() {
    const known = Object.keys(FIELDS)
    const suspicious = []
    for (const [name, value] of Object.entries(process.env)) {
        if (FIELDS[name] || value === '') continue
        if (!/^[A-Z][A-Z0-9_]*$/.test(name)) continue // skip npm_*/system/PascalCase noise
        let best = null
        let bestDistance = 3 // threshold: distance <= 2 counts as a likely typo
        for (const candidate of known) {
            const d = editDistance(name, candidate)
            if (d < bestDistance) {
                bestDistance = d
                best = candidate
            }
        }
        if (best) suspicious.push(`${name} (did you mean ${best}?)`)
    }
    if (suspicious.length) {
        console.warn(`Unrecognized environment variables that look like typos of known ones: ${suspicious.join(', ')}`)
    }
}

warnOnSuspiciousUnknowns()
