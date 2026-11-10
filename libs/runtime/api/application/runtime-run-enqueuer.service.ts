import { Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';

import type { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import {
    IOutboxMessageRepository,
    OUTBOX_MESSAGE_REPOSITORY_TOKEN,
} from '@libs/core/workflow/domain/contracts/outbox-message.repository.contract';
import { RUNTIME_RUN_TARGET_STORE_TOKEN, runTargetOf, type RunTarget, type RunTargetStore } from '@libs/runtime-publish/domain/run-target';
import { randomUUID } from 'crypto';

import {
    RuntimeEventName,
    RuntimeRunCancelRequestedSchema,
    RuntimeRunRequestedSchema,
    runtimeRunOutboxMessage,
    type RuntimeRunCancelRequested,
    type RuntimeRunRequested,
} from '@libs/runtime/run';

export const RUNTIME_PLATFORM_RESOLVER = Symbol.for('RuntimeApi.PlatformResolver');

/** The code-management platform of an org and team (CodeManagementService.getTypeIntegration). */
export interface RuntimePlatformResolver {
    getTypeIntegration(input: { organizationId: string; teamId: string }): Promise<PlatformType | null>;
}

export { runTargetOf };

/**
 * The one way the product enqueues a Run ("Run again" today, the PR trigger
 * next): the publish target goes to the product's `runtime_run_targets` first,
 * then the outbox row. The publisher takes the target only from that record
 * (ADR-052), so a Run without one publishes nothing.
 */
@Injectable()
export class RuntimeRunEnqueuer {
    constructor(
        @Inject(RUNTIME_RUN_TARGET_STORE_TOKEN)
        private readonly targets: RunTargetStore,
        @Inject(OUTBOX_MESSAGE_REPOSITORY_TOKEN)
        private readonly outbox: Pick<IOutboxMessageRepository, 'create' | 'createBatch'>,
        @Inject(RUNTIME_PLATFORM_RESOLVER)
        private readonly platforms: RuntimePlatformResolver,
    ) {}

    async enqueue(request: RuntimeRunRequested): Promise<void> {
        const parsed = RuntimeRunRequestedSchema.parse(request);
        const platform = await this.platforms.getTypeIntegration({ organizationId: parsed.organizationId, teamId: parsed.teamId });
        if (!platform) {
            throw new ServiceUnavailableException('The organization has no Git integration to publish the Run on');
        }
        await this.targets.record(runTargetOf(parsed, platform));
        await this.outbox.create(runtimeRunOutboxMessage(parsed, RuntimeEventName.RunRequested, parsed.runId));
    }

    /**
     * A simulation (trigger `simulate`): the outbox row only. Without a stored
     * target the publisher refuses anything the Run asks to post.
     */
    async enqueueSimulation(request: RuntimeRunRequested): Promise<void> {
        const parsed = RuntimeRunRequestedSchema.parse(request);
        if (parsed.trigger !== 'simulate') throw new Error('enqueueSimulation takes only simulate Runs');
        await this.outbox.create(runtimeRunOutboxMessage(parsed, RuntimeEventName.RunRequested, parsed.runId));
    }

    /** §7: a bounded simulation batch is enqueued atomically, without any publication target. */
    async enqueueSimulations(requests: RuntimeRunRequested[]): Promise<void> {
        if (!Array.isArray(requests) || requests.length < 1 || requests.length > 5) throw new Error('a simulation batch requires one to five Runs');
        const parsed = requests.map((request) => RuntimeRunRequestedSchema.parse(request));
        const first = parsed[0];
        if (parsed.some((request) => request.trigger !== 'simulate'
            || request.organizationId !== first.organizationId
            || request.teamId !== first.teamId
            || request.repository.id !== first.repository.id
            || request.environment.environmentId !== first.environment.environmentId)
            || new Set(parsed.map((request) => request.pullRequest.number)).size !== parsed.length
            || new Set(parsed.map((request) => request.runId)).size !== parsed.length) {
            throw new Error('a simulation batch requires unique Runs of one environment');
        }
        await this.outbox.createBatch(parsed.map((request) => runtimeRunOutboxMessage(request, RuntimeEventName.RunRequested, request.runId)));
    }

    /**
     * Asks the Runtime to cancel the live Runs of a PR: closed, or a new head
     * (`superseded` keeps the Runs of `headSha` and cancels every other one).
     */
    async cancel(request: RuntimeRunCancelRequested): Promise<void> {
        const parsed = RuntimeRunCancelRequestedSchema.parse(request);
        await this.outbox.create(runtimeRunOutboxMessage(parsed, RuntimeEventName.RunCancelRequested, randomUUID()));
    }

    /** The target the product stored for a Run it enqueued, or null. */
    storedTarget(runId: string): Promise<RunTarget | null> {
        return this.targets.get(runId);
    }
}
