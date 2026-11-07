import { useEffect, useId } from 'react'
import { AlertTriangle } from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { registerDeployDecisionHost, useDeployDecisionStore, type DeployAnswer, type DeployQuestion } from '@/store/deployDecisionStore'

export function describeDeployQuestion(q: DeployQuestion): string {
  if (!q.existingLabel && !q.libraryLabel) return `${q.accountLabel} already has a different ${q.addonName} config.`
  return `${q.accountLabel} has ${q.addonName} set up with ${q.existingLabel ?? 'a different config'}. Your library copy uses ${q.libraryLabel ?? 'a different config'}.`
}

// Names accounts when each remaining question is on its own account, questions otherwise.
export function applyToRestLabel(q: Pick<DeployQuestion, 'index' | 'total' | 'remainingAccounts'>): string {
  const remaining = q.total - q.index
  const accounts = q.remainingAccounts ?? remaining
  if (accounts === remaining) return accounts === 1 ? 'Apply my choice to the remaining account' : `Apply my choice to the remaining ${accounts} accounts`
  return remaining === 1 ? 'Apply my choice to the remaining question' : `Apply my choice to the remaining ${remaining} questions`
}

function CopyRow({ lead, name, label }: { lead: string; name: string; label: string | null }) {
  return (
    <div className="flex items-center gap-2.5 rounded-xl border border-border/35 bg-background/70 px-2.5 py-2">
      <span className="w-[104px] flex-none text-[11px] font-semibold uppercase tracking-[0.02em] text-muted-foreground">{lead}</span>
      <span aria-hidden="true" className="flex h-[30px] w-[30px] flex-none items-center justify-center rounded-[9px] bg-primary/15 text-[13px] font-bold text-primary">
        {name.charAt(0).toUpperCase()}
      </span>
      <div className="min-w-0">
        <div className="truncate text-[13px] font-semibold">{name}</div>
        <div className="mt-0.5 inline-flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
          {label ? (
            <>Config <span className="rounded-full border border-border/60 bg-muted/40 px-2 py-px font-medium">{label}</span></>
          ) : 'Different config'}
        </div>
      </div>
    </div>
  )
}

interface DeployDecisionBodyProps {
  question: DeployQuestion
  applyToRest: boolean
  onApplyToRestChange: (value: boolean) => void
  onAnswer: (answer: DeployAnswer) => void
  descriptionId?: string
  copiesId?: string
}

export function DeployDecisionBody({ question, applyToRest, onApplyToRestChange, onAnswer, descriptionId, copiesId }: DeployDecisionBodyProps) {
  const remaining = question.total - question.index
  return (
    <>
      <DialogHeader className="items-center px-5 pb-1 pt-6 text-center sm:px-6 sm:pr-6 sm:text-center">
        <div data-theme-part="badge" className="mb-3 flex h-[52px] w-[52px] items-center justify-center rounded-[15px] border border-warning/35 bg-warning/10 text-warning">
          <AlertTriangle className="h-6 w-6" aria-hidden="true" />
        </div>
        <DialogTitle className="text-[19px] leading-snug tracking-tight">This account already has {question.addonName}</DialogTitle>
        <DialogDescription id={descriptionId} className="mx-auto max-w-[360px] text-pretty text-[13px] leading-relaxed">
          {describeDeployQuestion(question)}
        </DialogDescription>
      </DialogHeader>
      <div className="px-5 sm:px-6">
        <div id={copiesId} data-theme-part="panel" className="mt-3.5 rounded-[14px] border border-border/40 bg-background/60 p-[11px] text-left">
          <div className="mb-2 ml-0.5 text-[11px] font-semibold text-muted-foreground">Copies</div>
          <div className="space-y-2">
            <CopyRow lead="On this account" name={question.addonName} label={question.existingLabel} />
            <CopyRow lead="From your library" name={question.addonName} label={question.libraryLabel} />
          </div>
        </div>
        {question.total > 1 && (
          <div className="mt-3 flex items-center justify-center gap-[7px] text-xs text-muted-foreground">
            <span>Question {question.index} of {question.total}</span>
            {Array.from({ length: question.total }, (_, i) => (
              <span key={i} aria-hidden="true" className={cn('h-1.5 w-1.5 rounded-full', i === question.index - 1 ? 'bg-primary' : 'bg-muted-foreground/40')} />
            ))}
          </div>
        )}
        {remaining > 0 && (
          <button
            type="button"
            role="switch"
            aria-checked={applyToRest}
            onClick={() => onApplyToRestChange(!applyToRest)}
            className="mt-2.5 flex min-h-12 w-full items-center gap-[11px] rounded-xl border border-border/40 bg-background/70 px-3 py-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span aria-hidden="true" className={cn('relative h-6 w-10 flex-none rounded-full transition-colors', applyToRest ? 'bg-primary' : 'bg-muted-foreground/40')}>
              <i className={cn('absolute top-[3px] h-[18px] w-[18px] rounded-full bg-white transition-[left]', applyToRest ? 'left-[19px]' : 'left-[3px]')} />
            </span>
            <span className="text-[12.5px] font-medium leading-snug">{applyToRestLabel(question)}</span>
          </button>
        )}
      </div>
      <div className="mt-3.5 grid grid-cols-2 gap-2.5 px-5 pb-4 sm:px-6">
        <Button data-autofocus="true" className="h-11 rounded-full" ripple={false} onClick={() => onAnswer({ choice: 'keep', applyToRest })}>
          Keep both
        </Button>
        <Button variant="destructive" className="h-11 rounded-full" ripple={false} onClick={() => onAnswer({ choice: 'replace', applyToRest })}>
          Replace
        </Button>
        <Button variant="subtle" className="col-span-2 h-11 rounded-full" ripple={false} onClick={() => onAnswer('cancel')}>
          Cancel
        </Button>
      </div>
    </>
  )
}

export const DEPLOY_DECISION_CONTENT_CLASS = 'gap-0 overflow-hidden p-0 sm:p-0 sm:max-w-md'

interface DeployDecisionSheetProps {
  question: DeployQuestion | null
  applyToRest: boolean
  onApplyToRestChange: (value: boolean) => void
  onAnswer: (answer: DeployAnswer) => void
}

export function DeployDecisionSheet({ question, applyToRest, onApplyToRestChange, onAnswer }: DeployDecisionSheetProps) {
  const descriptionId = useId()
  const copiesId = useId()

  return (
    <Dialog open={!!question} onOpenChange={open => { if (!open) onAnswer('cancel') }} describedBy={`${descriptionId} ${copiesId}`}>
      {question && (
        <DialogContent hideClose className={DEPLOY_DECISION_CONTENT_CLASS}>
          <DeployDecisionBody question={question} applyToRest={applyToRest} onApplyToRestChange={onApplyToRestChange} onAnswer={onAnswer} descriptionId={descriptionId} copiesId={copiesId} />
        </DialogContent>
      )}
    </Dialog>
  )
}

// The switch lives with the queued request, so every new request starts with it off.
export function DeployDecisionHost() {
  const question = useDeployDecisionStore(s => s.question)
  const applyToRest = useDeployDecisionStore(s => s.applyToRest)
  const setApplyToRest = useDeployDecisionStore(s => s.setApplyToRest)
  const requestId = useDeployDecisionStore(s => s.requestId)
  const answer = useDeployDecisionStore(s => s.answer)
  useEffect(() => registerDeployDecisionHost(), [])
  return <DeployDecisionSheet question={question} applyToRest={applyToRest} onApplyToRestChange={setApplyToRest} onAnswer={a => answer(requestId, a)} />
}
