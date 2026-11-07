import { lazy, Suspense, useMemo, useState } from 'react'
import { Check, ChevronRight, Import, ShieldCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { StatusChip } from '@/components/ui/status-chip'
import { useAccountStore } from '@/store/accountStore'
import { useAuthStore } from '@/store/authStore'
import { useUIStore } from '@/store/uiStore'
import { cn, maskEmailLevel, maskNameLevel, maskProfileLevel } from '@/lib/utils'
import { watchMigrationSources } from '@/lib/watch-state/sources'
import { watchMigrationDestinations } from '@/lib/watch-state/destinations'
import { PlatformLogo } from './ConnectionPrimitives'
import { watchConnectionLabel } from './watch-migration-labels'

const WatchMigrationDialog = lazy(() => import('./WatchMigrationDialog').then(module => ({ default: module.WatchMigrationDialog })))

function StepPills({ label, steps, current }: { label: string; steps: string[]; current: number }) {
    return <ol aria-label={label} className="flex flex-wrap items-center gap-x-1 gap-y-1.5">
        {steps.map((step, index) => <li key={step} aria-current={index === current ? 'step' : undefined} className="flex items-center gap-1">
            <span className={cn('inline-flex h-7 items-center gap-1.5 rounded-lg border px-2.5 text-xs', index === current ? 'border-primary/25 bg-primary/10 font-medium text-foreground' : 'border-border/40 bg-muted/30 text-muted-foreground')}>
                <span className={cn('flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] tabular-nums', index === current ? 'bg-primary text-primary-foreground' : 'bg-muted')}>{index + 1}</span>{step}
            </span>
            {index < steps.length - 1 && <ChevronRight aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-muted-foreground/40" />}
        </li>)}
    </ol>
}

export function WatchMigrationPicker({ accountId, embedded = false }: { accountId: string; embedded?: boolean }) {
    const account = useAccountStore(state => state.accounts.find(item => item.id === accountId))
    const key = useAuthStore(state => state.encryptionKey)
    const privacy = useUIStore(state => state.isPrivacyModeEnabled)
    const names = useUIStore(state => state.privacyLevelNames)
    const emails = useUIStore(state => state.privacyLevelEmail)
    const profiles = useUIStore(state => state.privacyLevelProfiles)
    const [open, setOpen] = useState(false)
    const [destinationId, setDestinationId] = useState('')
    const [importId, setImportId] = useState('')
    const connections = useMemo(() => account ? watchMigrationSources(account) : [], [account])
    const destinations = useMemo(() => account ? watchMigrationDestinations(account) : [], [account])
    const selected = destinations.find(connection => connection.id === destinationId)
    const destination = destinations.find(connection => connection.id === importId)
    const mask = (name: string) => name.includes('@') ? maskEmailLevel(name, privacy ? emails : 0) : maskNameLevel(name, privacy ? names : 0)
    const maskProfile = (name: string) => maskProfileLevel(name, privacy ? profiles : 0)

    if (!connections.length) return embedded ? <div data-theme-part="panel" className="flex items-start gap-3 rounded-2xl border border-border/40 bg-card p-4 shadow-sm"><span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-primary/20 bg-primary/10 text-primary"><Import aria-hidden="true" className="h-4 w-4" /></span><div className="min-w-0"><h3 className="text-sm font-semibold">Watch history</h3><p className="mt-1 max-w-prose text-xs leading-relaxed text-muted-foreground">Add an enabled media connection in Linked accounts to import watched titles and playback positions.</p></div></div> : null
    const destinationPicker = <div className="@container w-full">
        <div className="grid items-start gap-3 @3xl:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
            <div data-theme-part="panel" className={`min-w-0 space-y-3 rounded-2xl border bg-card p-4 shadow-sm ${selected ? 'border-primary/40' : 'border-border/40'}`}>
                <div className="space-y-1.5">
                    <div className="flex items-center justify-between gap-2"><p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Destination</p><StatusChip size="sm" variant="muted">Required</StatusChip></div>
                    <Label htmlFor="watch-import-destination" className="block font-semibold">Receive history in</Label>
                    <p className="text-xs leading-relaxed text-muted-foreground">Choose the connection that receives the changes you approve.</p>
                </div>
                <Select value={destinationId} onValueChange={setDestinationId}>
                    <SelectTrigger id="watch-import-destination"><SelectValue placeholder="Choose a destination connection" /></SelectTrigger>
                    <SelectContent>{destinations.map(connection => <SelectItem key={connection.id} value={connection.id}>
                        <span className="flex min-w-0 items-center gap-2"><PlatformLogo platform={connection.platform} className="h-6 w-6 shrink-0" /><span className="min-w-0 break-words">{watchConnectionLabel(connection, connections, account, mask, maskProfile)}</span></span>
                    </SelectItem>)}</SelectContent>
                </Select>
                {selected
                    ? <div className="flex min-w-0 items-start gap-2 rounded-lg border border-border/40 bg-muted/30 px-3 py-2 text-xs leading-relaxed text-muted-foreground"><PlatformLogo platform={selected.platform} className="mt-0.5 h-4 w-4 shrink-0 rounded-[5px]" /><span className="min-w-0 flex-1">Selected: {watchConnectionLabel(selected, connections, account, mask, maskProfile)}. This connection receives the changes you approve.</span></div>
                    : destinations.length ? <div className="flex min-w-0 items-start gap-2 rounded-lg border border-border/40 bg-muted/30 px-3 py-2 text-xs leading-relaxed text-muted-foreground"><Import aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" /><span className="min-w-0 flex-1">No destination yet. You’ll choose the source and preview every change next.</span></div>
                    : <p className="text-xs leading-relaxed text-muted-foreground">Add a supported media connection as a destination to continue.</p>}
            </div>
            <aside data-theme-part="panel" className="min-w-0 space-y-3 rounded-2xl border border-border/40 bg-card p-4 shadow-sm">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">What an import writes</p>
                <ul className="space-y-1.5 text-xs leading-relaxed text-muted-foreground">
                    <li className="flex items-start gap-2"><Check aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />{selected?.platform === 'realstream' ? 'Movie progress with a verified TMDB match' : 'Watched titles'}</li>
                    <li className="flex items-start gap-2"><Check aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />Continue-watching positions</li>
                    <li className="flex items-start gap-2"><ShieldCheck aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />Nothing else. Existing history is kept.</li>
                </ul>
                {selected?.platform === 'realstream' && <div className="rounded-lg border border-border/40 bg-muted/30 p-3">
                    <div className="flex items-start gap-2.5">
                        <PlatformLogo platform="realstream" className="h-8 w-8 shrink-0 rounded-lg" />
                        <div className="min-w-0">
                            <p className="text-sm font-semibold leading-tight">RealStream</p>
                            <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">Import movie progress into Continue Watching. RealStream may still start playback from the beginning. Episodes and watched flags are not supported.</p>
                        </div>
                    </div>
                </div>}
            </aside>
        </div>
    </div>
    return <>
        {embedded ? <section aria-label="Watch history" className="min-w-0 space-y-4">
            <div className="min-w-0">
                <h3 className="sr-only">Move watch history between connections</h3>
                <p className="text-xs leading-relaxed text-muted-foreground">{destinations.length} {destinations.length === 1 ? 'destination' : 'destinations'}. Move watch history between connections. Copy selected watched titles and resume points: choose where they go, read a source, then preview the differences before saving.</p>
            </div>
            <StepPills label="Watch history import steps" steps={['Choose destination', 'Read source & preview', 'Select changes & import']} current={0} />
            <div>{destinationPicker}</div>
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/40 pt-4"><p className="max-w-lg text-xs leading-relaxed text-muted-foreground">This is a manual import. Connecting accounts does not keep their histories synchronized. Available dates and play counts depend on the destination.</p><Button disabled={!key || !selected} onClick={() => setImportId(destinationId)}>Choose source &amp; preview</Button></div>
        </section> : <div data-theme-part="panel" className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border/40 bg-card/50 p-4">
            <div className="flex min-w-0 items-start gap-3"><span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-primary/20 bg-primary/10 text-primary"><Import aria-hidden="true" className="h-4 w-4" /></span><div><p className="text-sm font-semibold">Watch history</p><p className="mt-1 text-xs leading-relaxed text-muted-foreground">Copy watched titles and playback positions into a selected connection.</p></div></div>
            <Button variant="outline" size="sm" disabled={!key || !destinations.length} onClick={() => { setDestinationId(''); setOpen(true) }}><Import className="h-3.5 w-3.5" />Import watch state</Button>
        </div>}
        <Dialog open={open} onOpenChange={setOpen}>
            <DialogContent>
                <DialogHeader><DialogTitle>Choose an import destination</DialogTitle><DialogDescription>Select the connection that should receive watch history. You’ll choose the source and preview every change next.</DialogDescription></DialogHeader>
                <StepPills label="Watch history import progress" steps={['Destination', 'Source & preview', 'Import']} current={0} />
                {destinationPicker}
                <DialogFooter><Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button><Button disabled={!selected} onClick={() => { setImportId(destinationId); setOpen(false) }}>Continue</Button></DialogFooter>
            </DialogContent>
        </Dialog>
        {destination && <Suspense fallback={null}><WatchMigrationDialog key={destination.id} open onOpenChange={value => { if (!value) setImportId('') }} accountId={accountId} connection={destination} /></Suspense>}
    </>
}
