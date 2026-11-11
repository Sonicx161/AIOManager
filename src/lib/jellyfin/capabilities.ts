import type { JellyfinProduct } from './types.ts'

// Per-product capability rows for the connection panel's "What this server
// supports" note. Row wording follows the approved mockup; the per-product
// limits come from the facade sources checked on 2026-11-10 (AIOMetadata has
// no real multi-device sessions and both facades keep collection edits in
// their own configuration). Keep this one table small and typed so product
// changes stay one-line edits.
//
// An unidentified product ('compatible') makes no feature claims at all: the
// card then shows only the neutral summary sentence.
export interface JellyfinCapabilityRow {
    feature: string
    status: 'works' | 'limited'
    reason?: string
    /** Plain qualifier for conditional support; only ever on works rows. */
    note?: string
}

export interface JellyfinProductCapabilities {
    summary: string
    rows: JellyfinCapabilityRow[]
}

export const JELLYFIN_CAPABILITY_NOTE_SUBTITLE = 'Works for this connection; other servers can differ.'
export const JELLYFIN_CAPABILITY_NOTE_FOOTER = 'Based on the server type detected when this connection was verified.'

const works = (feature: string): JellyfinCapabilityRow => ({ feature, status: 'works' })
const worksWithNote = (feature: string, note: string): JellyfinCapabilityRow => ({ feature, status: 'works', note })
const limited = (feature: string, reason: string): JellyfinCapabilityRow => ({ feature, status: 'limited', reason })

const BASE_ROWS: JellyfinCapabilityRow[] = [
    works('Watch history and continue watching'),
    works('Mark watched, fix progress'),
    works('Favorites and likes'),
    works('Create and edit playlists'),
    works('Sign in with a Quick Connect code'),
    works('See other devices playing now'),
    works('Control a playing device from a Jellyfin app'),
    works('Create and edit collections'),
]

// Native Jellyfin exposes both features but gates them: Quick Connect can be
// switched off server-side, collection writes need the user's edit permission.
const NATIVE_ROWS: JellyfinCapabilityRow[] = [
    ...BASE_ROWS.slice(0, 4),
    worksWithNote('Sign in with a Quick Connect code', 'Needs Quick Connect switched on in the server settings.'),
    BASE_ROWS[5],
    BASE_ROWS[6],
    worksWithNote('Create and edit collections', 'Needs a user with permission to edit collections.'),
]

export const JELLYFIN_CAPABILITIES: Record<JellyfinProduct, JellyfinProductCapabilities> = {
    jellyfin: {
        summary: 'Everything AIOManager does works on this server.',
        rows: NATIVE_ROWS,
    },
    aiostreams: {
        summary: 'Everything works except editing collections.',
        rows: [
            ...BASE_ROWS.slice(0, 7),
            limited('Create and edit collections', 'View only; edits happen in AIOStreams'),
        ],
    },
    aiometadata: {
        summary: "History, favorites and playlists work; other devices and collection edits don't.",
        rows: [
            ...BASE_ROWS.slice(0, 5),
            limited('See other devices playing now', 'Only shows playback started here'),
            limited('Control a playing device from a Jellyfin app', 'Not available on this server'),
            limited('Create and edit collections', 'View only; edits happen in the AIOMetadata configuration'),
        ],
    },
    compatible: {
        summary: "AIOManager couldn't tell which server type this is, so it can't list what's supported.",
        rows: [],
    },
}
