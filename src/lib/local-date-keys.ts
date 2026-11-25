import { format } from 'date-fns'

const pad2 = (n: number) => (n < 10 ? '0' : '') + n

/** Same string as date-fns format(date, 'yyyy-MM'), without the formatter on the common path. */
export function localMonthKey(date: Date): string {
    const year = date.getFullYear()
    if (!(year >= 1000 && year <= 9999)) return format(date, 'yyyy-MM')
    return `${year}-${pad2(date.getMonth() + 1)}`
}

/** Same string as date-fns format(date, 'yyyy-MM-dd'). */
export function localDayKeyOf(date: Date): string {
    const year = date.getFullYear()
    if (!(year >= 1000 && year <= 9999)) return format(date, 'yyyy-MM-dd')
    return `${year}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}
