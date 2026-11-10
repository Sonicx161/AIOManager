// The entrance plays once per tab; same-tab revisits render its final state directly.
const KEY = 'aiom-replay-entrance'

export function replayEntrancePlayed(): boolean {
    try { return sessionStorage.getItem(KEY) === '1' } catch { return false }
}

export function markReplayEntrancePlayed(): void {
    try { sessionStorage.setItem(KEY, '1') } catch { /* storage unavailable: entrance simply replays */ }
}
