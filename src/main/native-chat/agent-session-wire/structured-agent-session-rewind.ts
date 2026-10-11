import { agentSessionProviderHandleChainHead } from '../../../shared/agent-session-provider-handle'
import { agentJournalLinkageFields } from '../../../shared/agent-session-journal-producer'
import {
  agentJournalItemKey,
  parseAgentJournalItemKey
} from '../../../shared/agent-session-journal-item-key'
import type { JournalOperationReceipt } from '../agent-session-journal/journal-row-writer'
import type {
  AgentSessionRewindParams,
  AgentSessionRewindRecord,
  AgentSessionRewindResult
} from '../../../shared/agent-session-rewind'
import type { AgentSessionMutationResult } from '../../../shared/agent-session-wire'
import { AGENT_SESSION_HISTORY_MAX_PAGE_BYTES } from './agent-session-history-page-bounds'
import type { StructuredAgentSessionMutationContext } from './structured-agent-session-host-mutations'
import type { StructuredAgentSessionAttachContext } from './structured-agent-session-attach-context'
import type { StructuredAgentSessionCaller } from './structured-agent-session-host-types'
import { admitAndRunAgentSessionMutation } from './structured-agent-session-mutation-admission'
import { conversationCommandBlocked } from './structured-conversation-command-admission'
import { rewindRefusal, rewindRefusalBehindClear } from './structured-rewind-refusal'
import { renameRewindTurnOpener } from './structured-rewind-journal-body'
import { persistRewindRecord, recoverStructuredRewind } from './structured-rewind-recovery'
import { mergeRetainedHostLifecycleRows } from './structured-rewind-retained-host-rows'
import { codexRewindTurnBoundary, rewindProviderItemKey } from './structured-rewind-target'
import {
  openWithReadyStructuredAgentSessionChild,
  prepareReadyStructuredAgentSessionOperation,
  type ReadyOperationChild
} from './structured-agent-session-ready-operation'

export async function rewindStructuredAgentSession(
  context: StructuredAgentSessionMutationContext,
  attachContext: StructuredAgentSessionAttachContext,
  caller: StructuredAgentSessionCaller,
  params: AgentSessionRewindParams
): Promise<AgentSessionMutationResult<AgentSessionRewindResult>> {
  const ready = await prepareReadyStructuredAgentSessionOperation(
    context,
    caller.callerKey,
    params.envelope,
    'agentSession.rewind',
    { itemId: params.itemId, expectedEpoch: params.expectedEpoch }
  )
  return ready.ok
    ? rewindUnderSerialize(context, attachContext, caller, params, ready.child)
    : ready
}

function rewindUnderSerialize(
  context: StructuredAgentSessionMutationContext,
  attachContext: StructuredAgentSessionAttachContext,
  caller: StructuredAgentSessionCaller,
  params: AgentSessionRewindParams,
  selected: ReadyOperationChild
): Promise<AgentSessionMutationResult<AgentSessionRewindResult>> {
  const { sessionId, clientOperationId } = params.envelope
  const store = context.deps.store
  return context.serialize(sessionId, async () => {
    let completionReceipt: JournalOperationReceipt | undefined
    const result = await admitAndRunAgentSessionMutation<AgentSessionRewindResult>({
      store,
      adapter: context.deps.adapter,
      agents: context.deps.agents,
      logger: context.deps.logger,
      callerKey: caller.callerKey,
      envelope: params.envelope,
      // Only the provider can do this, so an agent at rest is started first.
      prepareSession: async (ledger) => {
        const blocked =
          ledger === 'admit'
            ? rewindRefusalBehindClear(context.sessions.get(sessionId)?.journal, params)
            : null
        return (
          blocked ??
          openWithReadyStructuredAgentSessionChild(context, params.envelope, selected)(ledger)
        )
      },
      journal: () => context.sessions.get(sessionId)?.journal,
      publish: (journal) => context.publish(sessionId, journal),
      now: context.now,
      plan: {
        method: 'agentSession.rewind',
        fields: { itemId: params.itemId, expectedEpoch: params.expectedEpoch },
        recoverUnknownFromDurableState: true,
        settledOutcome: (rewind: AgentSessionRewindResult) => ({
          status: 'succeeded' as const,
          sessionId,
          rewind
        }),
        settlesWithWrite: true,
        successReceipt: () => ({
          write: (db) => completionReceipt!.write(db),
          committed: () => completionReceipt!.committed()
        }),
        replay: (_ctx, outcome) => {
          if (outcome.status === 'succeeded' && outcome.rewind) {
            return outcome.rewind
          }
          const prior = store.getRecord(sessionId)?.rewind
          return prior?.operationId === clientOperationId &&
            prior.callerKey === caller.callerKey &&
            prior.phase === 'completed' &&
            prior.epoch
            ? {
                itemId: prior.itemId,
                epoch: prior.epoch,
                ...(prior.sequence !== undefined ? { sequence: prior.sequence } : {})
              }
            : null
        },
        run: async (ctx) => {
          await attachContext.runtimeState.flushEventSink(sessionId)
          const record = store.getRecord(sessionId)!
          const support = ctx.adapter.rewindSupport?.(sessionId, ctx.agent)
          if (!support?.supported) {
            return rewindRefusal(support?.reason ?? 'unsupported')
          }
          if (
            record.rewind?.phase === 'prepared' ||
            record.rewind?.phase === 'provider-succeeded'
          ) {
            return rewindRefusal('outcome-unknown')
          }
          if (conversationCommandBlocked(ctx, record, context.readChildWork(sessionId))) {
            return rewindRefusal('busy')
          }
          const snapshot = ctx.journal.snapshot()
          const contextFloor = ctx.journal.context.floor()
          const contextStart = contextFloor
            ? snapshot.items.findIndex((item) => item.sequence > contextFloor.sequence)
            : 0
          const providerKey = rewindProviderItemKey(snapshot)
          if (ctx.journal.cursor().epoch !== params.expectedEpoch) {
            return rewindRefusal('stale-epoch')
          }
          const selected = snapshot.items.findIndex((item) => item.itemId === params.itemId)
          const key =
            selected === -1 ||
            (contextFloor && snapshot.items[selected].sequence <= contextFloor.sequence)
              ? null
              : parseAgentJournalItemKey(providerKey(params.itemId))
          // The head belongs to the record's provider: the record store refuses any other.
          const head = agentSessionProviderHandleChainHead(record.providerHandleChain)?.handle
          if (!key || !head || key.provider !== record.provider) {
            return rewindRefusal('invalid-target')
          }
          let boundary = selected
          if (key.provider === 'codex') {
            if (key.threadId !== head.nativeId) {
              return rewindRefusal('invalid-target')
            }
            boundary = codexRewindTurnBoundary({
              items: snapshot.items,
              contextFloor,
              threadId: key.threadId,
              turnId: key.turnId,
              providerKey
            })
          } else {
            return rewindRefusal('invalid-target')
          }
          const retained = snapshot.items
            .slice(Math.max(0, contextStart), boundary)
            .map(({ itemId, observedAt, turnScope, ...linkage }) => {
              const body = ctx.journal.itemBody(itemId)
              if (!body) {
                throw new Error('agent_session_rewind:missing-retained-item')
              }
              return {
                itemId: providerKey(itemId),
                body: renameRewindTurnOpener(body, providerKey),
                observedAt,
                ...(turnScope ? { turnScope } : {}),
                ...agentJournalLinkageFields(linkage)
              }
            })
          if (
            retained.length > 10_000 ||
            Buffer.byteLength(JSON.stringify(retained), 'utf8') >
              AGENT_SESSION_HISTORY_MAX_PAGE_BYTES
          ) {
            return rewindRefusal('history-limit')
          }
          let prepared: AgentSessionRewindRecord = {
            operationId: clientOperationId,
            callerKey: caller.callerKey,
            itemId: params.itemId,
            providerItemId: providerKey(params.itemId),
            expectedEpoch: params.expectedEpoch,
            phase: 'prepared',
            ...(contextFloor && record.providerContextBoundary
              ? {
                  contextClearOperationId: record.providerContextBoundary.operationId,
                  contextClearSequence: contextFloor.sequence
                }
              : {}),
            retained
          }
          await persistRewindRecord(store, sessionId, ctx.fence, prepared)
          ctx.publish()
          const provider = await ctx.adapter.rewind!({
            sessionId,
            fence: ctx.fence,
            beforeTurnId: key.provider === 'codex' ? key.turnId : '',
            onPrepared: async (items) => {
              const retained = mergeRetainedHostLifecycleRows(
                prepared.retained,
                items.map(({ identity, body }) => ({
                  itemId: agentJournalItemKey(identity),
                  body,
                  observedAt: ctx.now()
                }))
              )
              if (
                retained.length > 10_000 ||
                Buffer.byteLength(JSON.stringify(retained), 'utf8') >
                  AGENT_SESSION_HISTORY_MAX_PAGE_BYTES
              ) {
                throw new Error('agent_session_rewind:history-limit')
              }
              prepared = { ...prepared, retained }
              await persistRewindRecord(store, sessionId, ctx.fence, prepared)
            }
          })
          const fence = store.getRecord(sessionId)!.lease.runtimeFence
          if (!provider.ok) {
            const reason = provider.reason
            if (reason !== 'outcome-unknown') {
              await persistRewindRecord(store, sessionId, fence, {
                ...prepared,
                phase: 'refused',
                reason,
                retained: []
              })
              const currentJournal = context.sessions.get(sessionId)?.journal
              if (currentJournal) {
                context.publish(sessionId, currentJournal)
              }
            }
            return rewindRefusal(reason)
          }
          const confirmed = provider.items
            ? mergeRetainedHostLifecycleRows(
                prepared.retained,
                provider.items.map(({ identity, body }) => ({
                  itemId: agentJournalItemKey(identity),
                  body,
                  observedAt: ctx.now()
                }))
              )
            : prepared.retained
          if (
            confirmed.length > 10_000 ||
            Buffer.byteLength(JSON.stringify(confirmed), 'utf8') >
              AGENT_SESSION_HISTORY_MAX_PAGE_BYTES
          ) {
            throw new Error('agent_session_rewind:history-limit')
          }
          await persistRewindRecord(store, sessionId, fence, {
            ...prepared,
            retained: confirmed,
            phase: 'provider-succeeded',
            hydrationVerified: true
          })
          const journal = context.sessions.get(sessionId)!.journal
          await attachContext.runtimeState.flushEventSink(sessionId)
          await recoverStructuredRewind(
            context.deps,
            sessionId,
            journal,
            fence,
            undefined,
            ctx.now,
            (rewind, currentFence, cursor) => {
              completionReceipt = store.conversationReceipts.rewind(
                sessionId,
                currentFence,
                rewind,
                cursor
              )
              return ctx.operationReceipt!
            }
          )
          context.publish(sessionId, journal)
          return {
            ok: true,
            value: {
              itemId: params.itemId,
              epoch: journal.cursor().epoch,
              ...(contextFloor ? { sequence: journal.cursor().sequence } : {})
            }
          }
        }
      }
    })
    return result.ok
      ? {
          ...result,
          fence: store.getRecord(sessionId)!.lease.runtimeFence,
          cursor: context.sessions.get(sessionId)!.journal.cursor()
        }
      : result
  })
}
