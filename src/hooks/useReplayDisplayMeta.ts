export function useReplayDisplayMeta(yearData: number | string) {
    const isMonth = typeof yearData === 'string' && yearData !== 'all-time' && yearData.includes('-')
    const displayYear = isMonth ? (yearData as string).split('-')[0] : yearData === 'all-time' ? 'All-Time' : yearData
    const displayMonth = isMonth ? (() => {
        const [dy, dm] = (yearData as string).split('-').map(Number)
        return new Date(dy, dm - 1, 1).toLocaleString('default', { month: 'long' })
    })() : null
    const isCurrentYear = isMonth
        ? (yearData as string) === `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`
        : yearData === new Date().getFullYear()

    return {
        isMonth,
        displayYear,
        displayMonth,
        isCurrentYear
    }
}
