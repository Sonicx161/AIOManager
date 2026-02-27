import { useState, useEffect, useRef } from 'react'
import { ActivityItem } from '@/types/activity'

export function useMetricsWorker(items: ActivityItem[]) {
    const [results, setResults] = useState<any>(null)
    const [isComputing, setIsComputing] = useState(false)
    const workerRef = useRef<Worker | null>(null)
    const lastFingerprintRef = useRef<string>('')

    useEffect(() => {
        if (!workerRef.current) {
            console.log('[useMetricsWorker] Initializing worker...')
            workerRef.current = new Worker(
                new URL('../workers/metricsWorker.ts', import.meta.url),
                { type: 'module' }
            )

            workerRef.current.onmessage = (e) => {
                setResults(e.data)
                setIsComputing(false)
            }
        }

        return () => {
            if (workerRef.current) {
                console.log('[useMetricsWorker] Terminating worker...')
                workerRef.current.terminate()
                workerRef.current = null
            }
        }
    }, [])

    useEffect(() => {
        if (!workerRef.current || items.length === 0) {
            setResults(null)
            setIsComputing(false)
            lastFingerprintRef.current = ''
            return
        }

        // Create a unique fingerprint based on items length, first and last item IDs/times
        const first = items[0]
        const last = items[items.length - 1]
        const fingerprint = `${items.length}-${first.id}-${first.timestamp}-${last.id}-${last.timestamp}`

        if (fingerprint === lastFingerprintRef.current) {
            return
        }

        lastFingerprintRef.current = fingerprint
        setIsComputing(true)
        workerRef.current.postMessage({ items })
    }, [items])

    return { results, isComputing }
}
