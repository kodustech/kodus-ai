import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';

import { Action, ResourceType } from '@libs/identity/domain/permissions/enums/permissions.enum';
import type { IUser } from '@libs/identity/domain/user/interfaces/user.interface';
import { AuthorizationService } from '@libs/identity/infrastructure/adapters/services/permissions/authorization.service';
import type { RuntimeRunProjection } from '@libs/runtime/run';

import { RUNTIME_RUN_PROJECTION_STORE, type RunProjectionReader } from '../../domain/ports';
import type { RuntimeRunCost } from '../../domain/run-cost';
import { RuntimeRunCostService } from '../run-cost.service';
import type { RuntimeAuthorization } from '../run-access.service';
import { publicRunCheck } from '../run-public-view';

export interface RuntimeRunSummary {
    runId: string;
    attempt: number;
    repositoryId: string;
    repositoryName: string;
    prNumber: number;
    headSha: string;
    baseBranch?: string;
    state: RuntimeRunProjection['state'];
    verdictState?: RuntimeRunProjection['verdictState'];
    phase?: string;
    check: { conclusion: string; title: string };
    cellOwner?: RuntimeRunProjection['cellOwner'];
    requestedAt: string;
    finishedAt?: string;
    /** Machine time and LLM tokens at list prices: an estimate (§11, PR 5). Absent where it was not computed. */
    cost?: RuntimeRunCost;
}

export const toRunSummary = (r: RuntimeRunProjection, cost?: RuntimeRunCost): RuntimeRunSummary => ({
    runId: r.runId,
    attempt: r.attempt,
    repositoryId: r.repositoryId,
    repositoryName: r.repositoryName,
    prNumber: r.prNumber,
    headSha: r.headSha,
    ...(r.baseBranch === undefined ? {} : { baseBranch: r.baseBranch }),
    state: r.state,
    verdictState: r.verdictState,
    phase: r.phase,
    check: publicRunCheck(r),
    cellOwner: r.cellOwner,
    requestedAt: r.requestedAt,
    finishedAt: r.finishedAt,
    ...(cost ? { cost } : {}),
});

const MAX_LIMIT = 200;

/** GET /runtime/runs?repositoryId=&prNumber= — Runs of the caller's org, cut to the repos the caller can read. */
@Injectable()
export class ListRuntimeRunsUseCase {
    constructor(
        @Inject(RUNTIME_RUN_PROJECTION_STORE)
        private readonly runs: RunProjectionReader,
        @Inject(AuthorizationService)
        private readonly authorization: RuntimeAuthorization,
        private readonly costs: RuntimeRunCostService,
    ) {}

    private async withCost(runs: RuntimeRunProjection[]): Promise<RuntimeRunSummary[]> {
        const costs = await this.costs.forRuns(runs);
        return runs.map((r) => toRunSummary(r, costs.get(r.runId)));
    }

    async execute(input: { user: Partial<IUser>; repositoryId?: string; prNumber?: number; limit?: number }): Promise<RuntimeRunSummary[]> {
        const organizationId = input.user?.organization?.uuid;
        if (!organizationId) throw new NotFoundException('Organization not found');
        const limit = input.limit === undefined ? 50 : Number(input.limit);
        if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
            throw new BadRequestException(`limit must be an integer between 1 and ${MAX_LIMIT}`);
        }
        const prNumber = input.prNumber === undefined ? undefined : Number(input.prNumber);
        if (prNumber !== undefined && (!Number.isInteger(prNumber) || prNumber < 1)) {
            throw new BadRequestException('prNumber must be a positive integer');
        }
        if (prNumber !== undefined && !input.repositoryId) throw new BadRequestException('prNumber needs repositoryId');

        if (input.repositoryId) {
            await this.authorization.ensure({
                user: input.user,
                action: Action.Read,
                resource: ResourceType.RuntimeRun,
                repoIds: [input.repositoryId],
            });
            const runs = await this.runs.list({ organizationId, repositoryId: input.repositoryId, prNumber, limit });
            return this.withCost(runs);
        }

        const scope = await this.authorization.getRepositoryScope({
            user: input.user,
            action: Action.Read,
            resource: ResourceType.RuntimeRun,
        });
        if (scope !== null && scope.length === 0) return [];
        // The repository scope goes into the query: cutting the org's latest Runs would hide a scoped user's own.
        const runs = await this.runs.list({ organizationId, limit, ...(scope === null ? {} : { repositoryIds: scope }) });
        return this.withCost(runs);
    }
}
