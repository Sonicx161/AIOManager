import { useState, useEffect } from 'react'
import { Rocket, Copy, Check } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useSyncStore } from '@/store/syncStore'
import { motion, AnimatePresence } from 'framer-motion'

export function SyncIdReminder() {
    const { auth } = useSyncStore()
    const [show, setShow] = useState(false)
    const [hasCopied, setHasCopied] = useState(false)

    useEffect(() => {
        const flag = localStorage.getItem('aiom_show_sync_id_reminder')
        if (flag === 'true' && auth.isAuthenticated && auth.id) {
            setShow(true)
        }
    }, [auth.isAuthenticated, auth.id])

    const handleDismiss = () => {
        setShow(false)
        localStorage.removeItem('aiom_show_sync_id_reminder')
    }

    const handleCopy = () => {
        if (!auth.id) return
        navigator.clipboard.writeText(auth.id)
        setHasCopied(true)
        setTimeout(() => setHasCopied(false), 2000)
    }

    return (
        <AnimatePresence>
            {show && (
                <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    className="bg-primary/10 border-b border-primary/20 overflow-hidden relative"
                >
                    <div className="container mx-auto px-4 py-3 flex flex-col md:flex-row items-center justify-between gap-4">
                        <div className="flex items-center gap-3">
                            <div className="h-10 w-10 rounded-full bg-primary/20 flex items-center justify-center shrink-0">
                                <Rocket className="h-5 w-5 text-primary" />
                            </div>
                            <div className="space-y-0.5">
                                <p className="text-sm font-semibold flex items-center gap-2">
                                    Account Successfully Created!
                                </p>
                                <p className="text-[11px] text-muted-foreground leading-tight max-w-md">
                                    This is your <strong>Account UUID</strong>. Save it somewhere safe like a password manager, e.g. Bitwarden.
                                    It is the <strong>only way</strong> to access your data later as we do not have a password reset system.
                                </p>
                            </div>
                        </div>

                        <div className="flex items-center gap-2 w-full md:w-auto">
                            <div className="flex-1 md:flex-none flex items-center gap-2 bg-background/50 border rounded-lg px-3 py-1.5 font-mono text-xs select-all">
                                <span className="truncate max-w-[150px] md:max-w-[200px]">{auth.id}</span>
                                <Button
                                    size="icon"
                                    variant="ghost"
                                    className="h-7 w-7 shrink-0"
                                    onClick={handleCopy}
                                >
                                    {hasCopied ? <Check className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3" />}
                                </Button>
                            </div>

                            <Button size="sm" onClick={handleDismiss} className="shrink-0">
                                I've Saved It
                            </Button>
                        </div>
                    </div>
                </motion.div>
            )}
        </AnimatePresence>
    )
}
