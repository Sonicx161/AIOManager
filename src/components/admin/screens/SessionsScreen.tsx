import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { LogOut, Monitor } from 'lucide-react'
import { toast } from '@/hooks/use-toast'
import { adminLogout, getAdminSessions, revokeAdminSession, revokeAllAdminSessions } from '@/api/admin'
import { adminRetry, endAdminSession, paneErrorCopy, paneView, staleNoteCopy } from '@/lib/admin-queries'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { Chip, LegendNote, PaneError, PaneLoading, Panel, PanelHead, ScreenHeader, StaleNotice, TABLE_ROW, TABLE_SURFACE } from '../AdminWidgets'
import { TypedActionDialog } from '../TypedActionDialog'
import { ConfirmationDialog } from '@/components/ui/confirmation-dialog'

export function SessionsScreen() {
  const queryClient = useQueryClient()
  const [revokeAllOpen, setRevokeAllOpen] = useState(false)
  const [revokeOne, setRevokeOne] = useState<string | null>(null)

  const { data, isPending, isFetching, error, refetch } = useQuery({ queryKey: ['admin-sessions'], queryFn: getAdminSessions, staleTime: 15_000, retry: adminRetry })
  const view = paneView({ isPending, data, error })

  const revokeOneMut = useMutation({
    mutationFn: (id: string) => revokeAdminSession(id),
    onSuccess: () => {
      setRevokeOne(null)
      toast({ title: 'Session revoked' })
      queryClient.invalidateQueries({ queryKey: ['admin-sessions'] })
    },
    onError: (e: Error) => toast({ variant: 'destructive', title: 'Revoke failed', description: e.message }),
  })

  const revokeAllMut = useMutation({
    mutationFn: revokeAllAdminSessions,
    onSuccess: () => {
      setRevokeAllOpen(false)
      toast({ title: 'Signed out everywhere', description: 'Every dashboard session was revoked, including this one.' })
      endAdminSession(queryClient)
    },
    onError: (e: Error) => toast({ variant: 'destructive', title: 'Revoke failed', description: e.message }),
  })

  const signOutMut = useMutation({
    mutationFn: adminLogout,
    onSuccess: () => {
      toast({ title: 'Signed out of the dashboard' })
      endAdminSession(queryClient)
    },
    onError: (e: Error) => toast({ variant: 'destructive', title: 'Sign out failed', description: e.message }),
  })

  return (
    <div>
      <ScreenHeader
        title="Sessions"
        subtitle="Server-side revocable dashboard sessions with idle and absolute timeouts."
      />

      <div className="space-y-4">
        <Panel>
          <PanelHead
            icon={<Monitor />}
            title="Active sessions"
            detail={data?.note ?? 'Opaque ids, stored hashed server-side, so any session can be revoked.'}
            actions={
              <>
                <Button variant="ghost" size="sm" className="max-md:min-h-10" onClick={() => signOutMut.mutate()} disabled={signOutMut.isPending}>
                  <LogOut className="h-3.5 w-3.5" /> Sign out
                </Button>
                <Button variant="destructive" size="sm" className="max-md:min-h-10" onClick={() => setRevokeAllOpen(true)}>
                  <LogOut className="h-3.5 w-3.5" /> Sign out everywhere
                </Button>
              </>
            }
          />
          {view === 'stale' && <StaleNotice message={staleNoteCopy(error)} onRetry={() => refetch()} retrying={isFetching} />}
          {view === 'loading' ? (
            <PaneLoading />
          ) : view === 'gone' || !data ? (
            <PaneError message={paneErrorCopy(error, 'The session list')} onRetry={() => refetch()} retrying={isFetching} />
          ) : (
            <div className={TABLE_SURFACE}>
              {data.rows.map(s => (
                <div key={s.id} className={cn(TABLE_ROW, 'flex items-start gap-3 px-3.5 py-2.5')}>
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-muted text-foreground/85">
                    <Monitor className="h-3 w-3" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2 text-[13px] font-medium text-foreground">
                      {s.uaFamily}
                      {s.current && <Chip tone="ok">This session</Chip>}
                    </div>
                    <div className="mt-0.5 text-xs leading-relaxed">
                      {[s.createdLabel, `last seen ${s.lastSeenLabel}`, s.expiresLabel, s.ipPrefix].filter(Boolean).join(' \u00b7 ')}
                    </div>
                  </div>
                  {!s.current && (
                    <Button variant="destructive" size="sm" className="shrink-0 max-md:min-h-10" onClick={() => setRevokeOne(s.id)}>
                      Revoke
                    </Button>
                  )}
                </div>
              ))}
              {data.rows.length === 0 && <p className="px-3.5 py-4 text-center text-xs text-muted-foreground">No active dashboard sessions.</p>}
            </div>
          )}
          <LegendNote className="mt-3">
            {data?.idleTimeoutLabel ?? 'Idle timeout 30 min'}, {data?.absoluteTimeoutLabel ?? 'absolute max 8 h'}. After changing the password, use Sign out everywhere to end existing sessions.
          </LegendNote>
        </Panel>
      </div>

      <TypedActionDialog
        open={revokeAllOpen}
        onOpenChange={setRevokeAllOpen}
        title="Sign out everywhere?"
        description="Revokes every dashboard session, including this one. You sign in again with your username and password."
        confirmWord="REVOKE"
        requireReason={false}
        actionLabel="Sign out everywhere"
        destructive
        busy={revokeAllMut.isPending}
        onConfirm={() => revokeAllMut.mutate()}
      />

      <ConfirmationDialog
        open={!!revokeOne}
        onOpenChange={open => { if (!open) setRevokeOne(null) }}
        title="Revoke this session?"
        description="The device signs out of the dashboard at its next request. This session stays signed in."
        confirmText="Revoke session"
        cancelText="Cancel"
        isDestructive
        isLoading={revokeOneMut.isPending}
        onConfirm={() => revokeOne && revokeOneMut.mutate(revokeOne)}
      />
    </div>
  )
}
