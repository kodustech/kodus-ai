/**
 * code-review (domain) — thin wrapper over the onAgentProgress callback.
 *
 * Phase 4b of the provider decomposition. Captures the 4 fields every progress
 * event repeats (agentName / agentCategory / agentReplica{Index,Total}) once,
 * so emit sites only spell out what differs (status + payload). No-op when no
 * callback is wired.
 */
import type { AgentProgressEvent } from '@libs/code-review/infrastructure/agents/review-agent.contract';

type ProgressBase = Pick<
    AgentProgressEvent,
    'agentName' | 'agentCategory' | 'agentReplicaIndex' | 'agentReplicaTotal'
>;

type ProgressPayload = Omit<AgentProgressEvent, keyof ProgressBase>;

export class AgentProgressReporter {
    constructor(
        private readonly emit:
            | ((event: AgentProgressEvent) => void)
            | undefined,
        private readonly base: ProgressBase,
    ) {}

    send(payload: ProgressPayload): void {
        this.emit?.({ ...this.base, ...payload });
    }
}
