import { useEffect } from 'react'
import { useLocation } from 'react-router-dom'

export function ScrollToTop() {
    const { pathname, hash } = useLocation()

    useEffect(() => {
        // Only scroll to top if there's no hash (anchor link)
        if (!hash) {
            window.scrollTo(0, 0)
        }
    }, [pathname, hash])

    return null
}
