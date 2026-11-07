// UUIDs and long hex ids (Jellyfin user and server ids, config ids in facade paths) are never shown whole.
const ID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b|\b[0-9a-f]{16,}\b/gi

export function maskIds(text: string): string {
    return text.replace(ID_PATTERN, id => `${id.slice(0, 4)}\u2022\u2022\u2022\u2022`)
}
