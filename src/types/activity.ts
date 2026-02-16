export interface LibraryItem {
    _id: string
    name?: string
    type?: string
    poster?: string
    background?: string
    logo?: string
    removed?: boolean
    temp?: boolean
    state?: {
        lastWatched?: string
        timeOffset?: number
        duration?: number
        flaggedWatched?: number
        timesWatched?: number
        timeWatched?: number
        overallTimeWatched?: number
        video_id?: string
        watched?: string
        season?: number
        episode?: number
    }
    _ctime?: string
    _mtime?: string
}

export interface ActivityItem {
    id: string // Unique ID: accountId:uniqueItemId (episode-aware)
    accountId: string
    accountName: string
    accountColorIndex: number
    itemId: string // Base item ID (e.g., tt123)
    uniqueItemId: string // Episode-aware ID (e.g., tt123:1:5 for series)
    name: string
    type: string
    poster: string
    timestamp: Date
    duration: number
    watched: number
    progress: number
    season?: number
    episode?: number
    overallTimeWatched?: number
}
