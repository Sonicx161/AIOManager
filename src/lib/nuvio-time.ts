import { sourceTime } from './watch-state/records.ts'

export function nuvioSourceTime(value: unknown): number | null {
    const time = sourceTime(value)
    return time !== null && time <= Date.now() ? time : null
}
