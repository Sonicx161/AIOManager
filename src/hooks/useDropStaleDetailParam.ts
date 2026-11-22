import { useEffect, useRef } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { staleDetailCleanup } from '@/lib/detail-url'

// For pages that open a detail sheet only by tap: a navigation that lands here with ?detail= and no sheet open (Forward after Back, a pasted link) drops those parameters in place.
export function useDropStaleDetailParam(sheetOpen: boolean, active = true) {
    const location = useLocation()
    const navigate = useNavigate()
    const sheetOpenRef = useRef(sheetOpen)
    sheetOpenRef.current = sheetOpen
    useEffect(() => {
        if (!active || sheetOpenRef.current) return
        const next = staleDetailCleanup(location, window.location)
        if (next) navigate(next, { replace: true, state: location.state })
    }, [active, location, navigate])
}
