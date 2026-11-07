import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Clock } from 'lucide-react'
import { toast } from '@/hooks/use-toast'
import { getTasks, runTask, type TaskJob } from '@/api/admin'
import { adminRetry, paneErrorCopy, paneView, staleNoteCopy } from '@/lib/admin-queries'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { Chip, LegendNote, PaneError, PaneLoading, Panel, PanelHead, ScreenHeader, StaleNotice, TABLE_HEAD, TABLE_ROW, TABLE_SURFACE } from '../AdminWidgets'
import { TypedActionDialog } from '../TypedActionDialog'

export function TasksScreen() {
  const queryClient = useQueryClient()
  const [pending, setPending] = useState<TaskJob | null>(null)

  const { data, isPending, isFetching, error, refetch } = useQuery({ queryKey: ['admin-tasks'], queryFn: getTasks, staleTime: 30_000, retry: adminRetry })
  const view = paneView({ isPending, data, error })

  const run = useMutation({
    mutationFn: (job: TaskJob) => runTask(job.id, { confirm: 'RUN' }).then(() => job.name),
    onSuccess: (name: string) => {
      setPending(null)
      toast({ title: 'Job started', description: `${name} ran from the dashboard; the regular schedule is unaffected.` })
      queryClient.invalidateQueries({ queryKey: ['admin-tasks'] })
    },
    onError: (e: Error) => toast({ variant: 'destructive', title: 'Run failed', description: e.message }),
  })

  return (
    <div>
      <ScreenHeader title="Tasks" subtitle="Background jobs with their last run and schedule. Run-now only for idempotent jobs." />

      <div className="space-y-4">
        <Panel>
          <PanelHead icon={<Clock />} title="Scheduled jobs" detail="Registry of background jobs with last run and schedule." />
          {view === 'stale' && <StaleNotice message={staleNoteCopy(error)} onRetry={() => refetch()} retrying={isFetching} />}
          {view === 'loading' ? (
            <PaneLoading />
          ) : view === 'gone' || !data ? (
            <PaneError message={paneErrorCopy(error, 'The task list')} onRetry={() => refetch()} retrying={isFetching} />
          ) : (
            <>
              <div className={TABLE_SURFACE}>
                <div className={cn(TABLE_HEAD, 'hidden min-h-[34px] grid-cols-[1.4fr_1fr_0.9fr_0.7fr_0.9fr_auto] items-center gap-3 px-3.5 md:grid')}>
                  <span>Job</span><span>Schedule</span><span>Last run</span><span>State</span><span>Run-now</span><span />
                </div>
                {data.jobs.map(j => (
                  <div key={j.id} className={cn(TABLE_ROW, 'grid min-h-[52px] grid-cols-[1.3fr_1fr_auto] items-center gap-3 px-3.5 py-2 md:grid-cols-[1.4fr_1fr_0.9fr_0.7fr_0.9fr_auto]')}>
                    <span className="min-w-0">
                      <span className="block truncate text-[13px] font-semibold text-foreground">{j.name}</span>
                      <span className="block truncate md:hidden">{j.schedule}</span>
                    </span>
                    <span className="hidden md:block">{j.schedule}</span>
                    <span className={j.lastRunLabel ? undefined : 'text-muted-foreground'}>{j.lastRunLabel ?? 'never'}</span>
                    <span className="hidden md:block">{j.running ? 'running' : j.enabled ? 'enabled' : 'disabled'}</span>
                    <span className={cn('hidden md:block', !j.runnable && 'text-muted-foreground')}>{j.runnable ? 'ready' : '-'}</span>
                    <span className="flex justify-end">
                      {j.runnable ? (
                        <Button variant="outline" size="sm" className="max-md:min-h-10" onClick={() => setPending(j)}>Run now</Button>
                      ) : (
                        <Chip>{j.running ? 'running' : 'no run-now'}</Chip>
                      )}
                    </span>
                  </div>
                ))}
                {data.jobs.length === 0 && (
                  <div className="px-4 py-8 text-center text-xs text-muted-foreground">No background jobs are registered on this instance.</div>
                )}
              </div>
              {data.runNote && <p className="mt-2.5 text-xs text-muted-foreground">{data.runNote}</p>}
            </>
          )}
        </Panel>

        <LegendNote>
          <b>Why typed confirmation:</b> a manual run is written to the audit log. Autopilot keeps its own interval and lock, so it has no run-now. A missing backup job shows as a prompt, not a fake success.
        </LegendNote>
      </div>

      <TypedActionDialog
        open={!!pending}
        onOpenChange={open => { if (!open) setPending(null) }}
        title={pending ? `Run ${pending.name} now?` : ''}
        description={pending?.note ?? ''}
        confirmWord="RUN"
        requireReason={false}
        actionLabel="Run now"
        busy={run.isPending}
        onConfirm={() => pending && run.mutate(pending)}
      />
    </div>
  )
}
