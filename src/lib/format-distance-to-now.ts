// Faithful port of date-fns v4 formatDistanceToNow (en-US, addSuffix) so the
// eager boot path stops pulling the whole vendor-date chunk for one call site.
// Scoped to the options Header uses: addSuffix, no includeSeconds, no locale override.
const MINUTES_IN_DAY = 1440
const MINUTES_IN_MONTH = 43200
const MINUTES_IN_ALMOST_TWO_DAYS = 2520

const PATTERNS: Record<string, { one: string; other: string } | string> = {
    lessThanXMinutes: { one: 'less than a minute', other: 'less than {{count}} minutes' },
    xMinutes: { one: '1 minute', other: '{{count}} minutes' },
    aboutXHours: { one: 'about 1 hour', other: 'about {{count}} hours' },
    xDays: { one: '1 day', other: '{{count}} days' },
    aboutXMonths: { one: 'about 1 month', other: 'about {{count}} months' },
    xMonths: { one: '1 month', other: '{{count}} months' },
    aboutXYears: { one: 'about 1 year', other: 'about {{count}} years' },
    overXYears: { one: 'over 1 year', other: 'over {{count}} years' },
    almostXYears: { one: 'almost 1 year', other: 'almost {{count}} years' },
}

function localize(token: string, count: number, addSuffix: boolean | undefined, comparison: number): string {
    const tokenValue = PATTERNS[token]
    let result: string
    if (typeof tokenValue === 'string') {
        result = tokenValue
    } else if (count === 1) {
        result = tokenValue.one
    } else {
        result = tokenValue.other.replace('{{count}}', count.toString())
    }
    if (addSuffix) {
        return comparison > 0 ? `in ${result}` : `${result} ago`
    }
    return result
}

function tzOffsetMs(date: Date): number {
    const utc = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate(), date.getHours(), date.getMinutes(), date.getSeconds(), date.getMilliseconds()))
    utc.setUTCFullYear(date.getFullYear())
    return date.getTime() - utc.getTime()
}

function differenceInCalendarMonths(later: Date, earlier: Date): number {
    return 12 * (later.getFullYear() - earlier.getFullYear()) + (later.getMonth() - earlier.getMonth())
}

function isLastDayOfMonth(date: Date): boolean {
    return date.getDate() === new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate()
}

function differenceInMonths(laterDate: Date, earlierDate: Date): number {
    const sign = laterDate.getTime() > earlierDate.getTime() ? 1 : laterDate.getTime() < earlierDate.getTime() ? -1 : 0
    const difference = Math.abs(differenceInCalendarMonths(laterDate, earlierDate))
    if (difference < 1) return 0

    const workingLaterDate = new Date(laterDate)
    if (workingLaterDate.getMonth() === 1 && workingLaterDate.getDate() > 27) {
        workingLaterDate.setDate(30)
    }
    workingLaterDate.setMonth(workingLaterDate.getMonth() - sign * difference)

    let isLastMonthNotFull = (workingLaterDate.getTime() > earlierDate.getTime() ? 1 : workingLaterDate.getTime() < earlierDate.getTime() ? -1 : 0) === -sign

    if (isLastDayOfMonth(laterDate) && difference === 1 && laterDate.getTime() > earlierDate.getTime()) {
        isLastMonthNotFull = false
    }

    const result = sign * (difference - (isLastMonthNotFull ? 1 : 0))
    return result === 0 ? 0 : result
}

export function formatDistanceToNow(date: Date, options?: { addSuffix?: boolean }): string {
    const addSuffix = options?.addSuffix
    const now = new Date(Date.now())
    const diff = date.getTime() - now.getTime()
    const comparison = diff < 0 ? -1 : diff > 0 ? 1 : 0
    if (Number.isNaN(date.getTime())) throw new RangeError('Invalid time value')

    const [laterDate_, earlierDate_] = comparison > 0 ? [now, date] : [date, now]

    const seconds = Math.trunc((earlierDate_.getTime() - laterDate_.getTime()) / 1000)
    const offsetInSeconds = (tzOffsetMs(earlierDate_) - tzOffsetMs(laterDate_)) / 1000
    const minutes = Math.round((seconds - offsetInSeconds) / 60)
    let months: number

    if (minutes < 2) {
        if (minutes === 0) {
            return localize('lessThanXMinutes', 1, addSuffix, comparison)
        }
        return localize('xMinutes', minutes, addSuffix, comparison)
    } else if (minutes < 45) {
        return localize('xMinutes', minutes, addSuffix, comparison)
    } else if (minutes < 90) {
        return localize('aboutXHours', 1, addSuffix, comparison)
    } else if (minutes < MINUTES_IN_DAY) {
        return localize('aboutXHours', Math.round(minutes / 60), addSuffix, comparison)
    } else if (minutes < MINUTES_IN_ALMOST_TWO_DAYS) {
        return localize('xDays', 1, addSuffix, comparison)
    } else if (minutes < MINUTES_IN_MONTH) {
        return localize('xDays', Math.round(minutes / MINUTES_IN_DAY), addSuffix, comparison)
    } else if (minutes < MINUTES_IN_MONTH * 2) {
        months = Math.round(minutes / MINUTES_IN_MONTH)
        return localize('aboutXMonths', months, addSuffix, comparison)
    }

    months = differenceInMonths(earlierDate_, laterDate_)

    if (months < 12) {
        const nearestMonth = Math.round(minutes / MINUTES_IN_MONTH)
        return localize('xMonths', nearestMonth, addSuffix, comparison)
    } else {
        const monthsSinceStartOfYear = months % 12
        const years = Math.trunc(months / 12)
        if (monthsSinceStartOfYear < 3) {
            return localize('aboutXYears', years, addSuffix, comparison)
        } else if (monthsSinceStartOfYear < 9) {
            return localize('overXYears', years, addSuffix, comparison)
        } else {
            return localize('almostXYears', years + 1, addSuffix, comparison)
        }
    }
}
