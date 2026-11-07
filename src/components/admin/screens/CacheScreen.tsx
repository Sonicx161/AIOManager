import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Activity, Clipboard, Database, Download, KeyRound, RefreshCw, ShieldCheck, Trash2, Zap } from 'lucide-react'
import { toast } from '@/hooks/use-toast'
import { clearCacheLayer, getCache, type CacheLayer } from '@/api/admin'
import { adminRetry, paneErrorCopy, paneView, staleNoteCopy } from '@/lib/admin-queries'
import { Button } from '@/components/ui/button'
import { HBar, Kpi, LegendNote, PaneError, PaneLoading, Panel, PanelHead, ScreenHeader, StaleNotice } from '../AdminWidgets'
import { TypedActionDialog } from '../TypedActionDialog'

const LAYER_ICONS: Record<string, React.ReactNode> = {
  'metadata': <Database />,
  'sync-response': <RefreshCw />,
  'rules': <Zap />,
  'rule-decrypt': <ShieldCheck />,
  'health': <Activity />,
  'auth': <KeyRound />,
  'image': <Clipboard />,
  'manifest': <Download />,
}

function layerIcon(id: string): React.ReactNode {
  return LAYER_ICONS[id] ?? <Database />
}

export function CacheScreen() {
  const queryClient = useQueryClient()
  const [pending, setPending] = useState<CacheLayer | null>(null)

  const { data, isPending, isFetching, error, refetch } = useQuery({ queryKey: ['admin-cache'], queryFn: getCache, staleTime: 30_000, retry: adminRetry })
  const view = paneView({ isPending, data, error })
  const layers = data?.layers ?? []

  const clear = useMutation({
    mutationFn: (layer: CacheLayer) => clearCacheLayer(layer.id, { confirm: `CLEAR ${layer.short}` }).then(() => layer),
    onSuccess: (layer) => {
      setPending(null)
      toast({ title: 'Cache cleared', description: `${layer.name} was cleared. Everything refetches on demand; the clear is in the audit log.` })
      queryClient.invalidateQueries({ queryKey: ['admin-cache'] })
    },
    onError: (e: Error) => toast({ variant: 'destructive', title: 'Clear failed', description: e.message }),
  })

  return (
    <div>
      <ScreenHeader
        title="Cache"
        subtitle="Per-layer caches with per-layer clears. Never one big clear button."
      />

      {view === 'stale' && <StaleNotice message={staleNoteCopy(error)} onRetry={() => refetch()} retrying={isFetching} />}
      {view === 'loading' ? (
        <PaneLoading />
      ) : view === 'gone' || !data ? (
        <PaneError message={paneErrorCopy(error, 'The cache report')} onRetry={() => refetch()} retrying={isFetching} />
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {layers.slice(0, 4).map(l => (
              <Kpi
                key={l.id}
                label={l.name.split(' (')[0]}
                value={l.entriesLabel}
                detail={`${l.sizeLabel}${l.hitRatePct !== null ? `, ${l.hitRatePct}% hit rate` : ''}`}
                tone={l.tone}
              />
            ))}
          </div>

          <div className="mt-4 space-y-4">
            <Panel>
              <PanelHead icon={<RefreshCw />} title="Proxy queue" detail="The outbound request queue in front of upstream providers, sampled in memory." />
              <HBar label={data.proxyQueue.label} pct={data.proxyQueue.pct} value={data.proxyQueue.value} tone={data.proxyQueue.tone} />
            </Panel>

            {layers.length === 0 && (
              <Panel>
                <p className="py-4 text-center text-xs text-muted-foreground">No cache layers are reported on this instance.</p>
              </Panel>
            )}

            <div className="grid gap-4 lg:grid-cols-2">
              {layers.map(l => (
                <Panel key={l.id}>
                  <PanelHead
                    icon={layerIcon(l.id)}
                    title={l.name}
                    detail={l.note}
                    actions={l.clearable && (
                      <Button variant="destructive" size="sm" className="max-md:min-h-10" onClick={() => setPending(l)}>
                        <Trash2 className="h-3.5 w-3.5" /> Clear {l.short}
                      </Button>
                    )}
                  />
                  {l.rows.map(r => (
                    <HBar key={r.label} label={r.label} pct={r.pct} value={r.value} tone={r.tone} />
                  ))}
                </Panel>
              ))}
            </div>

            {!data.clearAvailable && (
              <LegendNote>
                <b>Reads only for now:</b> per-layer clears arrive with the actions update on the server; the confirmation will name the exact layer and entry count, and land in the audit log.
              </LegendNote>
            )}
          </div>
        </>
      )}

      <TypedActionDialog
        open={!!pending}
        onOpenChange={open => { if (!open) setPending(null) }}
        title={pending ? `Clear ${pending.name}?` : ''}
        description={pending ? `Drops ${pending.entries.toLocaleString('en-US')} rows, about ${pending.sizeLabel}. Everything refetches on demand, so the next minutes run slower and upstream sees more requests. The clear is written to the audit log.` : ''}
        confirmWord={`CLEAR ${pending?.short ?? ''}`}
        actionLabel={`Clear ${pending?.short ?? ''}`}
        destructive
        busy={clear.isPending}
        onConfirm={() => pending && clear.mutate(pending)}
      />
    </div>
  )
}
