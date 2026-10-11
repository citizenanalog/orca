import type {
  AgentJournalCursor,
  AgentJournalSnapshot
} from '../../../shared/agent-session-journal-types'
import {
  agentJournalSubmissionKey,
  parseAgentJournalItemKey
} from '../../../shared/agent-session-journal-item-key'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'

/** Accepted submissions retain the provider key even when their journal item uses a client key. */
export function rewindProviderItemKey(snapshot: AgentJournalSnapshot): (itemId: string) => string {
  const providerKeys = new Map(
    snapshot.submissions.flatMap((submission) =>
      submission.dispatchState === 'accepted' && submission.providerItemId
        ? [
            [
              agentJournalSubmissionKey(submission.clientMessageId),
              submission.providerItemId
            ] as const
          ]
        : []
    )
  )
  return (itemId) => providerKeys.get(itemId) ?? itemId
}

/** A Codex rewind retains nothing from the selected turn onward. */
export function codexRewindTurnBoundary(input: {
  items: AgentJournalSnapshot['items']
  contextFloor: AgentJournalCursor | null
  threadId: string
  turnId: string
  providerKey: (itemId: string) => string
}): number {
  const { items, contextFloor, threadId, turnId, providerKey } = input
  return items.findIndex((item) => {
    if (contextFloor && item.sequence <= contextFloor.sequence) {
      return false
    }
    const identity = parseAgentJournalItemKey(providerKey(item.itemId))
    return (
      (identity?.provider === 'codex' &&
        identity.threadId === threadId &&
        identity.turnId === turnId) ||
      readAgentJournalTurn(item.body)?.turnId === turnId
    )
  })
}
