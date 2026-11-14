import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';

import type { IUser } from '@libs/identity/domain/user/interfaces/user.interface';

import { RUNTIME_FINDING_INTENT_STORE, type FindingIntentStore } from '../../domain/ports';
import { RuntimeRunAccessService } from '../run-access.service';
import { intendedView, type FindingIntentView } from './get-run.use-case';

/**
 * PUT /runtime/runs/:id/findings/:probeId/intent { intended: boolean } — a
 * developer marks a finding of the Run as an intended change, or clears the
 * mark. Only a finding of this Run can be marked (another probe is 404).
 *
 * The mark is a learning signal kept in the product. It does not change the
 * Run, its verdict, its check or the PR comment, which say what Kody measured,
 * and it publishes nothing.
 */
@Injectable()
export class SetFindingIntentUseCase {
    constructor(
        private readonly access: RuntimeRunAccessService,
        @Inject(RUNTIME_FINDING_INTENT_STORE)
        private readonly intents: FindingIntentStore,
    ) {}

    async execute(input: { user: Partial<IUser>; runId: string; probeId: string; body: unknown }): Promise<{ intended: true } & FindingIntentView | { intended: false }> {
        const intended = (input.body as { intended?: unknown } | null)?.intended;
        if (typeof intended !== 'boolean') throw new BadRequestException('intended must be true or false');
        const run = await this.access.load({ kind: 'user', user: input.user }, input.runId);
        const isFinding = [...(run.findings ?? []), ...(run.probes ?? [])].some((p) => p.probeId === input.probeId && p.verdict === 'finding');
        if (!isFinding) throw new NotFoundException('This Run has no finding on that path');
        const userId = input.user?.uuid;
        if (!userId) throw new NotFoundException('User not found');
        await this.intents.set({ organizationId: run.organizationId, runId: run.runId, probeId: input.probeId, userId, intended });
        const rows = await this.intents.listForRun(run.organizationId, run.runId);
        const mark = intendedView(rows, userId)[input.probeId];
        return mark ? { intended: true, ...mark } : { intended: false };
    }
}
