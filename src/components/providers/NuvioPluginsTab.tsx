import { useCallback, useEffect, useState } from 'react'
import { Plus, Trash2, RefreshCw, Loader2, Copy, Link } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip } from '@/components/ui/tooltip'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { toast } from '@/hooks/use-toast'
import { cn } from '@/lib/utils'
import { EmptyState } from '@/components/common/EmptyState'
import { useConnectionStore } from '@/store/connectionStore'
import { useAccountStore } from '@/store/accountStore'
import { AccountPickerDialog } from '@/components/accounts/AccountPickerDialog'
import { readNuvioPlugins, writeNuvioPlugins } from '@/lib/nuvio-plugins'
import type { Connection, NuvioPluginDescriptor } from '@/types/connection'
import { connectionLabel } from './ConnectionPrimitives'

const sameList = (a: NuvioPluginDescriptor[], b: NuvioPluginDescriptor[]) =>
    a.length === b.length && a.every((p, i) =>
        p.url === b[i].url && p.name === b[i].name && p.enabled === b[i].enabled && (p.repo_type || '') === (b[i].repo_type || ''))

export function NuvioPluginsPanel({ accountId, connection }: { accountId: string; connection: Connection }) {
    const [plugins, setPlugins] = useState<NuvioPluginDescriptor[]>(connection.pluginList || [])
    const [baseline, setBaseline] = useState<NuvioPluginDescriptor[]>(connection.pluginList || [])
    const [loading, setLoading] = useState(false)
    const [saving, setSaving] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [newUrl, setNewUrl] = useState('')
    const [newName, setNewName] = useState('')
    const [cloneOpen, setCloneOpen] = useState(false)

    const updateConnection = useConnectionStore(s => s.updateConnection)
    const accounts = useAccountStore(s => s.accounts)
    const dirty = !sameList(plugins, baseline)

    const cloneToAccounts = async (targetIds: string[]) => {
        let ok = 0, skipped = 0, failed = 0
        for (const tid of targetIds) {
            const target = accounts.find(a => a.id === tid)
            const tconn = (target?.connections || []).find(c => c.enabled && c.platform === 'nuvio')
            if (tid === accountId || !tconn) { skipped++; continue }
            try {
                await writeNuvioPlugins(tid, tconn, baseline)
                updateConnection(tid, tconn.id, { pluginList: baseline })
                ok++
            } catch { failed++ }
        }
        setCloneOpen(false)
        toast({
            title: ok > 0 ? 'Plugins cloned' : 'Nothing cloned',
            description: `${ok} account(s) updated` + (skipped ? `, ${skipped} skipped (no Nuvio connection)` : '') + (failed ? `, ${failed} failed` : '') + '.',
            variant: ok > 0 ? undefined : 'destructive',
        })
    }

    const load = useCallback(async () => {
        setLoading(true)
        setError(null)
        try {
            const rows = await readNuvioPlugins(accountId, connection)
            setPlugins(rows)
            setBaseline(rows)
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Could not load plugins. Try re-authenticating this connection.')
        } finally {
            setLoading(false)
        }
    }, [accountId, connection])

    useEffect(() => { load() }, [load])

    const addPlugin = () => {
        const url = newUrl.trim()
        if (!url) return
        if (plugins.some(p => p.url.trim().toLowerCase() === url.toLowerCase())) {
            toast({ title: 'Plugin already added', variant: 'destructive' })
            return
        }
        setPlugins(prev => [...prev, { url, name: newName.trim() || url, enabled: true, sort_order: prev.length }])
        setNewUrl('')
        setNewName('')
    }

    const toggle = (i: number) => setPlugins(prev => prev.map((p, idx) => idx === i ? { ...p, enabled: !p.enabled } : p))
    const remove = (i: number) => setPlugins(prev => prev.filter((_, idx) => idx !== i))

    const save = async () => {
        setSaving(true)
        try {
            await writeNuvioPlugins(accountId, connection, plugins)
            updateConnection(accountId, connection.id, { pluginList: plugins })
            setBaseline(plugins)
            toast({ title: 'Plugins saved', description: `Synced ${plugins.length} plugin${plugins.length === 1 ? '' : 's'} to ${connectionLabel(connection)}.` })
        } catch (err) {
            toast({ title: 'Could not save plugins', description: err instanceof Error ? err.message : 'Try again.', variant: 'destructive' })
        } finally {
            setSaving(false)
        }
    }

    return (
        <div className="space-y-4">

            <div className="flex items-center gap-2">
                <p className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground flex-1">Plugins</p>
                {baseline.length > 0 && (
                    <span data-theme-part="badge" className="flex h-5 min-w-5 items-center justify-center rounded-md bg-muted px-1.5 text-xs font-semibold text-muted-foreground">
                        {plugins.length}
                    </span>
                )}
                <Tooltip content={dirty ? 'Save changes before cloning' : 'Clone these plugins to other accounts'}>
                    <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 gap-1.5 text-xs text-muted-foreground hover:text-foreground"
                        onClick={() => setCloneOpen(true)}
                        disabled={loading || saving || dirty || baseline.length === 0}
                    >
                        <Copy className="h-3.5 w-3.5" /> Clone
                    </Button>
                </Tooltip>
                <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 flex items-center justify-center text-muted-foreground hover:text-foreground"
                    onClick={load}
                    disabled={loading || saving}
                    aria-label="Reload plugins"
                >
                    <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
                </Button>
            </div>

            <AccountPickerDialog
                open={cloneOpen}
                onOpenChange={setCloneOpen}
                title="Clone Plugins"
                description="Copy this profile's plugins to other accounts that have a Nuvio connection. Accounts without one are skipped."
                onConfirm={cloneToAccounts}
                confirmLabel="Clone"
            />


            {error && (
                <div data-theme-tone="status" data-theme-part="panel" className="rounded-xl bg-destructive/10 border border-destructive/20 px-3.5 py-2.5 text-sm text-destructive">{error}</div>
            )}


            {loading && !error && (
                <div className="flex items-center justify-center gap-2 py-16 text-xs text-muted-foreground">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
                </div>
            )}


            {!loading && !error && (
                <div className="space-y-1.5">
                    {plugins.length === 0 && (
                        <EmptyState
                            icon={<Link className="h-5 w-5" />}
                            title="No plugins yet"
                            description="Add a plugin URL below to get started."
                        />
                    )}
                    {plugins.map((p, i) => (
                        <div
                            key={`${p.url}-${i}`}
                            data-theme-part="panel"
                            className="flex items-center gap-3 rounded-2xl border border-border/40 bg-card shadow-sm px-3.5 py-2.5 transition-[background-color,border-color,box-shadow,transform] duration-200 hover:-translate-y-0.5 hover:border-border/70 hover:bg-card/95 hover:shadow-md"
                        >
                            <div className="min-w-0 flex-1">
                                <p className={cn('text-sm font-medium truncate', !p.enabled && 'text-muted-foreground line-through')}>
                                    {p.name || p.url}
                                </p>
                                {p.name && <p className="text-[11px] text-muted-foreground/70 truncate mt-0.5">{p.url}</p>}
                            </div>
                            <Switch
                                checked={p.enabled}
                                onCheckedChange={() => toggle(i)}
                                className="shrink-0"
                                aria-label={`${p.enabled ? 'Disable' : 'Enable'} plugin`}
                            />
                            <Button
                                variant="ghost"
                                size="icon"
                                className="h-7 w-7 flex items-center justify-center shrink-0 text-muted-foreground hover:text-destructive"
                                onClick={() => remove(i)}
                                aria-label="Remove plugin"
                            >
                                <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                        </div>
                    ))}
                </div>
            )}


            {!loading && !error && (
                <div className="flex flex-col gap-2 border-t border-border/40 pt-4 sm:flex-row">
                    <Input
                        value={newUrl}
                        onChange={e => setNewUrl(e.target.value)}
                        placeholder="Plugin URL"
                        className="h-8 text-xs flex-1"
                        onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addPlugin() } }}
                    />
                    <Input
                        value={newName}
                        onChange={e => setNewName(e.target.value)}
                        placeholder="Name (optional)"
                        className="h-8 text-xs sm:w-40"
                        onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addPlugin() } }}
                    />
                    <Button size="sm" variant="outline" className="h-8 gap-1.5 text-xs shrink-0" onClick={addPlugin} disabled={!newUrl.trim()}>
                        <Plus className="h-3.5 w-3.5" /> Add
                    </Button>
                </div>
            )}


            {dirty && (
                <div data-theme-tone="status" data-theme-part="panel" className="flex items-center justify-between gap-3 rounded-2xl border border-warning/30 bg-warning/10 px-3.5 py-2.5 shadow-sm">
                    <p className="text-xs text-warning">Saving will replace this profile's plugins on Nuvio.</p>
                    <div className="flex gap-2 shrink-0">
                        <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setPlugins(baseline)} disabled={saving}>
                            Discard
                        </Button>
                        <Button size="sm" className="h-7 gap-1.5 text-xs" onClick={save} disabled={saving}>
                            {saving && <Loader2 className="h-3 w-3 animate-spin" />}
                            Save
                        </Button>
                    </div>
                </div>
            )}
        </div>
    )
}
