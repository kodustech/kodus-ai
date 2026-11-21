import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';

import type { IUser } from '@libs/identity/domain/user/interfaces/user.interface';

import { RUNTIME_FINDING_FEEDBACK_STORE, type FindingFeedbackStore, type FindingFeedbackValue } from '../../domain/ports';
import { RuntimeRunAccessService } from '../run-access.service';
import { feedbackView, type FindingFeedbackView } from './get-run.use-case';

/**
 * PUT /runtime/runs/:id/findings/:probeId/feedback { value: 'up' | 'down' | null }
 * — anyone who can read the Run votes once per tested path; null clears the vote.
 * The path must be one the Run tested (another Run's probe is 404).
 */
@Injectable()
export class SetFindingFeedbackUseCase {
    constructor(
        private readonly access: RuntimeRunAccessService,
        @Inject(RUNTIME_FINDING_FEEDBACK_STORE)
        private readonly feedback: FindingFeedbackStore,
    ) {}

    async execute(input: { user: Partial<IUser>; runId: string; probeId: string; body: unknown }): Promise<FindingFeedbackView> {
        const value = (input.body as { value?: unknown } | null)?.value;
        if (value !== null && value !== 'up' && value !== 'down') {
            throw new BadRequestException("value must be 'up', 'down' or null");
        }
        const run = await this.access.load({ kind: 'user', user: input.user }, input.runId);
        const tested = [...(run.probes ?? []), ...(run.findings ?? [])].some((p) => p.probeId === input.probeId);
        if (!tested) throw new NotFoundException('This Run did not test that path');
        const userId = input.user?.uuid;
        if (!userId) throw new NotFoundException('User not found');
        await this.feedback.set({
            organizationId: run.organizationId,
            runId: run.runId,
            probeId: input.probeId,
            userId,
            value: value as FindingFeedbackValue | null,
        });
        const rows = await this.feedback.listForRun(run.organizationId, run.runId);
        return feedbackView(rows.filter((r) => r.probeId === input.probeId), userId)[input.probeId] ?? { up: 0, down: 0 };
    }
}
