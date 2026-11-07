import { ScrollToTop } from '@/components/ScrollToTop'
import { AppRoutes } from '@/routes'
import { TooltipProvider } from '@/components/ui/tooltip'

// The public docs route renders without a session; its shell (tooltip
// provider + scroll restoration + routes) sits in its own chunk so the boot
// closure stays login-only while /kronorium keeps its exact tree.
export default function KronoriumShell() {
    return (
        <TooltipProvider delayDuration={700} skipDelayDuration={0}>
            <ScrollToTop />
            <AppRoutes />
        </TooltipProvider>
    )
}
