import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';

import { Action, ResourceType } from '@libs/identity/domain/permissions/enums/permissions.enum';
import type { IUser } from '@libs/identity/domain/user/interfaces/user.interface';
import { AuthorizationService } from '@libs/identity/infrastructure/adapters/services/permissions/authorization.service';
import type { RuntimeRunRequested } from '@libs/runtime/run/run-messages';

import {
    RUNTIME_GIT_PORT,
    RUNTIME_PRODUCT_ENVIRONMENT_STORE,
    RUNTIME_RUN_PROJECTION_STORE,
    type ProductEnvironmentStore,
    type PullRequestHead,
    type RunProjectionReader,
    type RuntimeGitPort,
} from '../../domain/ports';
import type { RuntimeAuthorization } from '../run-access.service';
import { RuntimeRunRequestBuilder } from '../run-request-builder.service';
import { RuntimeRunEnqueuer } from '../runtime-run-enqueuer.service';

type SimulationInput = { user: Partial<IUser>; environmentId: string; body: unknown };
type SimulationQueued = { runId: string; state: 'queued' };
type SimulationBatchQueued = { runs: Array<SimulationQueued & { prNumber: number }> };

function selectionOf(body: unknown): { single: boolean; prNumbers: number[] } {
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((key) => key !== 'prNumber' && key !== 'prNumbers')) {
        throw new BadRequestException('Provide either prNumber or prNumbers');
    }
    const value = body as { prNumber?: unknown; prNumbers?: unknown };
    const single = Object.hasOwn(value, 'prNumber') && value.prNumber !== undefined;
    const batch = Object.hasOwn(value, 'prNumbers') && value.prNumbers !== undefined;
    if (single === batch) throw new BadRequestException('Provide either prNumber or prNumbers');
    const numbers = single ? [value.prNumber] : value.prNumbers;
    if (!Array.isArray(numbers) || numbers.length < 1 || numbers.length > 5
        || numbers.some((number) => typeof number !== 'number' || !Number.isSafeInteger(number) || number < 1)
        || new Set(numbers).size !== numbers.length) {
        throw new BadRequestException('Select one to five unique positive integer PR numbers');
    }
    return { single, prNumbers: numbers as number[] };
}

/**
 * POST /runtime/environments/:id/simulate — "Try it" (screen 2) and §7's
 * historical simulation: { prNumber } or { prNumbers: [1..5 unique numbers] }.
 * Every PR is preflighted before token issuance; a batch's outbox rows commit
 * together. PRs may be open or closed. Nothing is posted: the worker
 * skips publishing, and the product records no publish target for the Run,
 * so the publisher refuses it anyway (ADR-052). The Run shows in Kodus only.
 */
@Injectable()
export class SimulateRuntimeRunUseCase {
    constructor(
        @Inject(RUNTIME_PRODUCT_ENVIRONMENT_STORE)
        private readonly environments: ProductEnvironmentStore,
        @Inject(AuthorizationService)
        private readonly authorization: RuntimeAuthorization,
        @Inject(RUNTIME_RUN_PROJECTION_STORE)
        private readonly runs: RunProjectionReader,
        @Inject(RUNTIME_GIT_PORT)
        private readonly git: RuntimeGitPort,
        private readonly requests: RuntimeRunRequestBuilder,
        private readonly enqueuer: RuntimeRunEnqueuer,
    ) {}

    execute(input: SimulationInput & { body: { prNumber: number } }): Promise<SimulationQueued>;
    execute(input: SimulationInput & { body: { prNumbers: number[] } }): Promise<SimulationBatchQueued>;
    execute(input: SimulationInput): Promise<SimulationQueued | SimulationBatchQueued>;
    async execute(input: SimulationInput): Promise<SimulationQueued | SimulationBatchQueued> {
        const organizationId = input.user?.organization?.uuid;
        if (!organizationId) throw new NotFoundException('Organization not found');
        const selection = selectionOf(input.body);
        const env =
            typeof input.environmentId === 'string' && input.environmentId.length <= 128
                ? await this.environments.get(organizationId, input.environmentId)
                : null;
        if (!env || env.organizationId !== organizationId) throw new NotFoundException('Environment not found');
        await this.authorization.ensure({
            user: input.user,
            action: Action.Update,
            resource: ResourceType.CodeReviewSettings,
            repoIds: [env.repositoryId],
        });

        const selected: Array<{ prNumber: number; head: PullRequestHead }> = [];
        // All authorization/head/fork/live checks finish before the first builder
        // can mint a token. Only pinned heads from the Git API reach the batch.
        for (const prNumber of selection.prNumbers) {
            const head = await this.git.getPullRequestHead({
                organizationId,
                teamId: env.teamId,
                repositoryId: env.repositoryId,
                repositoryName: env.repositoryName,
                prNumber,
            });
            if (!head) throw new NotFoundException('Pull request not found');
            // ADR-030: a simulation has no maintainer approval step.
            if (head.fork) throw new ConflictException('Pull requests from forks are not simulated');
            const live = (await this.runs.findLive({ organizationId, repositoryId: env.repositoryId, prNumber })).filter((r) => r.headSha === head.headSha);
            if (live.length) throw new ConflictException(`Run ${live[0].runId} is still running for this commit`);
            selected.push({ prNumber, head });
        }

        const requests: RuntimeRunRequested[] = [];
        for (const { prNumber, head } of selected) requests.push(await this.requests.build({ env, prNumber, head, trigger: 'simulate' }));
        if (selection.single) {
            await this.enqueuer.enqueueSimulation(requests[0]);
            return { runId: requests[0].runId, state: 'queued' };
        }
        await this.enqueuer.enqueueSimulations(requests);
        return { runs: requests.map((request) => ({ prNumber: request.pullRequest.number, runId: request.runId, state: 'queued' })) };
    }
}
