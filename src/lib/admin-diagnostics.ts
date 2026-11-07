/**
 * Plain-text diagnostics for the System screen's Copy diagnostics button
 * (DP-13). Built purely from the environment view strings plus the version
 * and mode payload the screen already holds: no extra fetches, no addresses,
 * no secrets, no hostnames. Each fact appears at most once; the node version
 * lives on the Runtime line only, matching the Version and mode panel.
 */

/** Display strings for the System environment cards; null rows are omitted everywhere. */
export interface SystemEnvironment {
    os: string | null
    cpu: string | null
    memory: string | null
    timezone: string | null
    container: string | null
    database: string | null
    dataDir: string | null
    build: string | null
}

export interface DiagnosticsTextInput {
    version: string
    mode: string
    /** The Version and mode panel's Runtime row; the only place the node version appears. */
    runtime: string
    environment: SystemEnvironment | null
}

export function formatDiagnosticsText({ version, mode, runtime, environment }: DiagnosticsTextInput): string {
    const lines = [
        'AIOManager system diagnostics',
        `Version: ${version}`,
        `Mode: ${mode}`,
        `Runtime: ${runtime}`,
    ]
    const e = environment
    if (e?.os) lines.push(`Operating system: ${e.os}`)
    if (e?.cpu) lines.push(`CPU: ${e.cpu}`)
    if (e?.memory) lines.push(`Memory: ${e.memory}`)
    if (e?.timezone) lines.push(`Timezone: ${e.timezone}`)
    if (e?.container) lines.push(`Container: ${e.container}`)
    if (e?.database) lines.push(`Database: ${e.database}`)
    if (e?.dataDir) lines.push(`Data folder: ${e.dataDir}`)
    if (e?.build) lines.push(`Build: ${e.build}`)
    return lines.join('\n')
}
