import { agentSessionLeaseAdmitsWriter } from '../../../shared/agent-session-lease-adjudication'
import type {
  StructuredAgentSessionOptionsReportedEvent,
  StructuredAgentSessionOptionsSkippedEvent
} from './structured-agent-session-adapter'
import { nativeSessionOptionsFromReport } from './structured-agent-session-option-restoration'
import { sameProviderChild } from './structured-agent-session-provider-child'
import type { StructuredAgentSessionProviderStartedContext } from './structured-agent-session-provider-started'
import { saveStructuredAgentSessionStartReadbackListing } from './structured-agent-session-start-listing'

type ReportedOptions = Omit<StructuredAgentSessionOptionsReportedEvent, 'type'>

/** What a ready child reports later, such as a read that came after its start: persisted as the
 *  start's report is, never ahead of a send. */
export function settleStructuredAgentSessionOptionsReported(
  context: StructuredAgentSessionProviderStartedContext,
  event: StructuredAgentSessionOptionsReportedEvent
): Promise<void> {
  const admitted = admitStructuredAgentSessionReportedOptions(context, event)
  if (event.catalogListing) {
    void saveStructuredAgentSessionStartReadbackListing(context, event, event.catalogListing)
  }
  return persistStructuredAgentSessionReportedOptions(context, event, admitted)
}

export function admitStructuredAgentSessionReportedOptions(
  context: StructuredAgentSessionProviderStartedContext,
  event: ReportedOptions
): number | null {
  return context.runtimeState.optionRevisions.admitReport(event.sessionId, event.optionRevision)
}

/** Non-fatal, and only for the child that reported, while its report is still the newest word: a
 *  pick or a later report since it was admitted is newer than what it read. */
export function persistStructuredAgentSessionReportedOptions(
  context: StructuredAgentSessionProviderStartedContext,
  event: ReportedOptions,
  admitted: number | null
): Promise<void> {
  if (admitted === null) {
    return Promise.resolve()
  }
  return context
    .serialize(event.sessionId, async () => {
      const child = context.sessions.get(event.sessionId)?.child
      const record = context.deps.store.getRecord(event.sessionId)
      if (
        !child ||
        !sameProviderChild(child, {
          generation: event.acquisitionGeneration,
          fence: event.fence
        }) ||
        !record ||
        record.lease.runtimeFence !== event.fence ||
        !agentSessionLeaseAdmitsWriter(record.lease) ||
        !context.runtimeState.optionRevisions.isNewest(
          event.sessionId,
          event.optionRevision,
          admitted
        )
      ) {
        return
      }
      try {
        await context.deps.store.replaceSessionOptions({
          sessionId: event.sessionId,
          fence: event.fence,
          options: nativeSessionOptionsFromReport({
            reported: event.reportedOptions,
            restoreSkipped: event.restoreSkippedOptions,
            ...(event.retiredOptions ? { retired: event.retiredOptions } : {}),
            ...(record.options ? { priorOptions: record.options } : {})
          }),
          now: context.now()
        })
      } finally {
        context.publishStatus?.(event.sessionId)
      }
    })
    .catch((error: unknown) => {
      context.deps.logger.warn('recording what a started provider reported failed', {
        scope: 'provider-started-options',
        sessionId: event.sessionId,
        error
      })
    })
}

/** A running child showed saved options it cannot run: the record drops them, as a start that
 *  skipped them would, so the next start runs the provider's own. Reported, never thrown. */
export function settleStructuredAgentSessionOptionsSkipped(
  context: StructuredAgentSessionProviderStartedContext,
  event: StructuredAgentSessionOptionsSkippedEvent
): Promise<void> {
  // A report read before the child showed this is out of date: it would write the value back.
  context.runtimeState.optionRevisions.advance(event.sessionId)
  return context.serialize(event.sessionId, async () => {
    const { store } = context.deps
    const record = store.getRecord(event.sessionId)
    if (
      !record?.options ||
      record.lease.runtimeFence !== event.fence ||
      !agentSessionLeaseAdmitsWriter(record.lease)
    ) {
      return
    }
    const options = { ...record.options }
    for (const [key, value] of Object.entries(event.options)) {
      // A pick made since the child launched is the user's, whatever the child showed.
      if (options[key] === value) {
        delete options[key]
      }
    }
    try {
      await store.replaceSessionOptions({
        sessionId: event.sessionId,
        fence: event.fence,
        options,
        now: context.now()
      })
    } catch (error) {
      context.deps.logger.warn('dropping a saved option the provider cannot run failed', {
        scope: 'provider-options-skipped',
        sessionId: event.sessionId,
        error
      })
    } finally {
      context.publishStatus?.(event.sessionId)
    }
  })
}
