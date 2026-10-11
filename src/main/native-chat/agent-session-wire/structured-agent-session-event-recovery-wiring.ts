import type { AgentSessionSubscribers } from './structured-agent-session-subscribers'
import { StructuredAgentSessionEventRecovery } from './structured-agent-session-event-recovery'
import { structuredAgentSessionConversationFence } from './structured-agent-session-provider-child'
import type { StructuredAgentSessionTaskQueue } from './structured-agent-session-task-queue'

type RecoveryContext = ConstructorParameters<typeof StructuredAgentSessionEventRecovery>[0]
type Wiring = Pick<
  RecoveryContext,
  | 'deps'
  | 'sessions'
  | 'runtimeState'
  | 'publishStatus'
  | 'wakeDelivery'
  | 'stopStartingChild'
  | 'now'
> & {
  subscribers: Pick<AgentSessionSubscribers, 'snapshot'>
  tasks: Pick<StructuredAgentSessionTaskQueue, 'trackAttach'>
  serialize: RecoveryContext['serialize']
}

export function createStructuredAgentSessionEventRecovery(
  input: Wiring
): StructuredAgentSessionEventRecovery {
  return new StructuredAgentSessionEventRecovery({
    deps: input.deps,
    store: input.deps.store,
    sessions: input.sessions,
    flushLifecycle: (sessionId) => input.runtimeState.lifecycleBarrier(sessionId),
    publishFence: (sessionId, session) =>
      input.subscribers.snapshot(
        sessionId,
        session.journal,
        structuredAgentSessionConversationFence(input.deps.store, sessionId)
      ),
    publishStatus: input.publishStatus,
    serialize: (sessionId, task) => input.tasks.trackAttach(input.serialize(sessionId, task)),
    now: input.now,
    runtimeState: input.runtimeState,
    wakeDelivery: input.wakeDelivery,
    stopStartingChild: input.stopStartingChild
  })
}
