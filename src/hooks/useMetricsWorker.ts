import { useState, useEffect, useRef } from 'react'
import { ActivityItem } from '@/store/activityStore'

export function useMetricsWorker(items: ActivityItem[]) {
    const [results, setResults] = useState<any>(null)
    const [isComputing, setIsComputing] = useState(false)
    const workerRef = useRef<Worker | null>(null)

    useEffect(() => {
        // Initialise worker using Vite's native syntax
        if (!workerRef.current) {
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
                workerRef.current.terminate()
                workerRef.current = null
            }
        }
    }, [])

    useEffect(() => {
        if (!workerRef.current || items.length === 0) {
            setResults(null)
            setIsComputing(false)
            return
        }

        setIsComputing(true)
        workerRef.current.postMessage({ items })
    }, [items])

    return { results, isComputing }
}
