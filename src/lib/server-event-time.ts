// Server activity events carry Stremio's flaggedWatched bit (0/1) in `watched`, and the
// resume offset in ms in `progress`.
export function isWatchedFlag(watched: number | undefined): boolean {
    return watched === 1
}

export function serverEventTimeWatched(event: { progress?: number; watched?: number }): number {
    if (event.progress) return event.progress
    return event.watched && !isWatchedFlag(event.watched) ? event.watched : 0
}
