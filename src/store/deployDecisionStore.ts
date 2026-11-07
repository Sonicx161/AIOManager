import { create } from 'zustand'
import type { DeployChoice } from '@/types/saved-addon'

export interface DeployQuestion {
  accountLabel: string
  addonName: string
  existingLabel: string | null
  libraryLabel: string | null
  index: number
  total: number
  // Accounts after this one that still have questions; defaults to one per question.
  remainingAccounts?: number
}

export type DeployAnswer = { choice: DeployChoice; applyToRest: boolean } | 'cancel'

type Request = { id: number; question: DeployQuestion; resolve: (answer: DeployAnswer) => void }

interface DeployDecisionState {
  hosts: number
  queue: Request[]
  question: DeployQuestion | null
  requestId: number | null
  // Per request: every new question starts with the switch off.
  applyToRest: boolean
  setApplyToRest: (value: boolean) => void
  // Answers name the request they were given for; a stale id or a tap within
  // INPUT_GUARD_MS of a new question appearing is ignored.
  answer: (requestId: number | null, answer: DeployAnswer) => void
}

export const INPUT_GUARD_MS = 250

let nextRequestId = 1
let shownAt = 0

const showHead = (queue: Request[]) => {
  shownAt = Date.now()
  return { queue, question: queue[0]?.question ?? null, requestId: queue[0]?.id ?? null, applyToRest: false }
}

// Questions from concurrent deployments queue FIFO; the sheet shows the head.
export const useDeployDecisionStore = create<DeployDecisionState>((set, get) => ({
  hosts: 0,
  queue: [],
  question: null,
  requestId: null,
  applyToRest: false,
  setApplyToRest: (value) => set({ applyToRest: value }),
  answer: (requestId, answer) => {
    const [head, ...rest] = get().queue
    if (!head || head.id !== requestId || Date.now() - shownAt < INPUT_GUARD_MS) return
    set(showHead(rest))
    head?.resolve(answer)
  },
}))

export function registerDeployDecisionHost(): () => void {
  useDeployDecisionStore.setState(s => ({ hosts: s.hosts + 1 }))
  return () => {
    useDeployDecisionStore.setState(s => ({ hosts: s.hosts - 1 }))
    if (useDeployDecisionStore.getState().hosts > 0) return
    const pending = useDeployDecisionStore.getState().queue
    useDeployDecisionStore.setState(showHead([]))
    for (const request of pending) request.resolve('cancel')
  }
}

// Resolves null when no sheet is mounted (headless callers keep both copies). An aborted
// signal (a cancelled batch) resolves 'cancel' and removes the question from the queue.
export function askDeployDecision(question: DeployQuestion, signal?: AbortSignal): Promise<DeployAnswer | null> {
  if (signal?.aborted) return Promise.resolve('cancel')
  if (useDeployDecisionStore.getState().hosts <= 0) return Promise.resolve(null)
  return new Promise(resolve => {
    const current = useDeployDecisionStore.getState().queue
    const request = { id: nextRequestId++, question, resolve }
    if (current.length === 0) useDeployDecisionStore.setState(showHead([request]))
    else useDeployDecisionStore.setState({ queue: [...current, request] })
    signal?.addEventListener('abort', () => {
      const queue = useDeployDecisionStore.getState().queue
      if (!queue.includes(request)) return
      const rest = queue.filter(r => r !== request)
      useDeployDecisionStore.setState(queue[0] === request ? showHead(rest) : { queue: rest })
      resolve('cancel')
    }, { once: true })
  })
}
