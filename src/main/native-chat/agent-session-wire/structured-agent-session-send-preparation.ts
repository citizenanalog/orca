// What a send or a Stop needs from the session before the ledger places its row: the
// conversation open. Nothing here needs an owner — a send is accepted into the conversation and
// the delivery loop makes the session ready — so a refusal before acceptance is only one the
// conversation itself makes: a journal that cannot be opened.

import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentSessionMutationEnvelope } from '../../../shared/agent-session-wire'
import { TUI_AGENT_DISPLAY_NAMES } from '../../../shared/tui-agent-display-names'
import { isTuiAgent } from '../../../shared/tui-agent-config'
import type { AgentSessionFailureWordsContext } from '../../../shared/agent-session-failure-words'
import { journalOpenRefusal } from '../agent-session-journal/journal-open-failure'
import {
  structuredAgentSessionAwaitedCommand,
  type StructuredAgentSessionAwaitedCommandJournal
} from './structured-agent-session-command-turn'
import type { StructuredAgentSessionHostSession } from './structured-agent-session-host-types'
import {
  AGENT_SESSION_NOT_ATTACHED,
  type AgentSessionMutationSessionPreparation
} from './structured-agent-session-mutation-admission'
import { agentSessionOperationOutcomeUnknown } from './structured-agent-session-replay-outcome'
import { conversationCommandInFlight } from './structured-conversation-command-admission'
import type { StructuredAgentSessionMutationContext } from './structured-agent-session-host-mutations'
import type { StructuredAgentSessionLogger } from './structured-agent-session-logger'

/** The conversation a send or a Stop writes to, opened when this host holds it closed. */
export async function openConversationForWrite(
  openConversation: (sessionId: string) => Promise<StructuredAgentSessionHostSession | null>,
  envelope: AgentSessionMutationEnvelope,
  logger: StructuredAgentSessionLogger
): Promise<AgentSessionMutationSessionPreparation> {
  let session: StructuredAgentSessionHostSession | null
  try {
    session = await openConversation(envelope.sessionId)
  } catch (error) {
    logger.warn('opening the conversation for a write failed', {
      scope: 'open-for-write',
      sessionId: envelope.sessionId,
      error
    })
    return { ok: false, refusal: journalOpenRefusal(error) }
  }
  if (!session) {
    return { ok: false, refusal: AGENT_SESSION_NOT_ATTACHED }
  }
  return { ok: true }
}

/** The conversation a write lands in, opened when this host holds it closed. */
export function openForWrite(
  context: Pick<StructuredAgentSessionMutationContext, 'openConversation' | 'deps'>,
  envelope: AgentSessionMutationEnvelope
): () => Promise<AgentSessionMutationSessionPreparation> {
  return () => openConversationForWrite(context.openConversation, envelope, context.deps.logger)
}

/** For an operation the running child performs, which starts none: the conversation, then any
 *  close a stop began on that child, which it joins, so it never reaches a child that takes no
 *  input. */
export function openForProviderWrite(
  context: Pick<
    StructuredAgentSessionMutationContext,
    'openConversation' | 'joinChildClose' | 'deps'
  >,
  envelope: AgentSessionMutationEnvelope
): () => Promise<AgentSessionMutationSessionPreparation> {
  return async () => {
    const opened = await openConversationForWrite(
      context.openConversation,
      envelope,
      context.deps.logger
    )
    return opened.ok ? context.joinChildClose(envelope.sessionId) : opened
  }
}

/** A send is accepted into the conversation; delivery settles a pending rewind before handover.
 *  A replay reads only its recorded answer. `clearInFlight` refuses a new send while a clear runs. */
export function sendPreparation(
  context: Pick<StructuredAgentSessionMutationContext, 'openConversation' | 'deps'>,
  envelope: AgentSessionMutationEnvelope,
  arrival: { clearInFlight?: boolean } = {}
): (ledger: 'admit' | 'replay') => Promise<AgentSessionMutationSessionPreparation> {
  return async (ledger) => {
    if (ledger === 'admit' && arrival.clearInFlight) {
      return { ok: false, refusal: conversationCommandInFlight() }
    }
    const opened = await openConversationForWrite(
      context.openConversation,
      envelope,
      context.deps.logger
    )
    if (ledger === 'replay') {
      return opened.ok
        ? opened
        : { ok: false, refusal: agentSessionOperationOutcomeUnknown(envelope.clientOperationId) }
    }
    return opened
  }
}

/** Who a failure sentence names: the chat's agent, when the record says; and, given the journal,
 *  the command a failed start leaves to run again. */
export function structuredAgentSessionFailureWordsContext(
  record: AgentSessionRecord | null,
  journal?: StructuredAgentSessionAwaitedCommandJournal
): AgentSessionFailureWordsContext {
  const command = journal && structuredAgentSessionAwaitedCommand(journal)
  return {
    ...(record && isTuiAgent(record.provider)
      ? { agentName: TUI_AGENT_DISPLAY_NAMES[record.provider] }
      : {}),
    ...(command ? { command } : {})
  }
}
