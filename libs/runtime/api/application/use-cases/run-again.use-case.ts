import {
    ConflictException,
    Inject,
    Injectable,
    NotFoundException,
    ServiceUnavailableException,
} from '@nestjs/common';

import { Action } from '@libs/identity/domain/permissions/enums/permissions.enum';
import type { IUser } from '@libs/identity/domain/user/interfaces/user.interface';
import { isTerminal } from '@libs/runtime/run';

import { deterministicUuid } from '../../domain/deterministic-id';
import {
    RUNTIME_API_CONFIG,
    RUNTIME_GIT_PORT,
    RUNTIME_RUN_PROJECTION_STORE,
    type RunProjectionReader,
    type RuntimeApiConfig,
    type RuntimeGitPort,
} from '../../domain/ports';
import { RuntimeRunAccessService } from '../run-access.service';
import { RuntimeRunRequestBuilder } from '../run-request-builder.service';
import { RuntimeRunEnqueuer } from '../runtime-run-enqueuer.service';

/**
 * POST /runtime/runs — "Run again": a new Run with attempt + 1, through the
 * outbox, only after the previous Run ended. The PR is read again from the Git
 * API (ADR-057); a moved head is a new push, which triggers its own Run.
 * The new runId is derived from the previous Run and the attempt, so two
 * clicks enqueue one Run. One live Run per org, repo, PR and SHA (also a
 * unique index in runtime_runs).
 */
@Injectable()
export class RunRuntimeAgainUseCase {
    constructor(
        private readonly access: RuntimeRunAccessService,
        @Inject(RUNTIME_RUN_PROJECTION_STORE)
        private readonly runs: RunProjectionReader,
        @Inject(RUNTIME_GIT_PORT)
        private readonly git: RuntimeGitPort,
        private readonly requests: RuntimeRunRequestBuilder,
        private readonly enqueuer: RuntimeRunEnqueuer,
        @Inject(RUNTIME_API_CONFIG)
        private readonly config: RuntimeApiConfig,
    ) {}

    async execute(input: { user: Partial<IUser>; runId: string }): Promise<{ runId: string; attempt: number; state: 'queued' }> {
        const previous = await this.access.load({ kind: 'user', user: input.user }, input.runId, Action.Create);
        if (!isTerminal(previous.state)) {
            throw new ConflictException('The previous Run has not finished yet');
        }
        if (!this.config.runTokenSecret) {
            throw new ServiceUnavailableException('Runtime run token secret is not configured');
        }

        // The repo and PR come from the target the product stored, never from
        // the Runtime's projection alone: both must agree.
        const target = await this.enqueuer.storedTarget(previous.runId);
        if (!target) throw new ConflictException('The previous Run has no target recorded by the product');
        if (
            target.organizationId !== previous.organizationId ||
            target.teamId !== previous.teamId ||
            target.repositoryId !== previous.repositoryId ||
            target.pullRequestNumber !== previous.prNumber ||
            target.headSha !== previous.headSha
        ) {
            throw new ConflictException('The previous Run does not match the target recorded by the product');
        }
        const orgTeam = { organizationId: target.organizationId, teamId: target.teamId };
        const repo = { repositoryId: target.repositoryId, repositoryName: target.repositoryName };
        const head = await this.git.getPullRequestHead({ ...orgTeam, ...repo, prNumber: previous.prNumber });
        if (!head) throw new NotFoundException('Pull request not found');
        if (head.state && head.state !== 'open') throw new ConflictException('The pull request is not open');
        if (head.headSha !== previous.headSha) {
            throw new ConflictException('The pull request has a newer head; that push runs on its own');
        }

        const key = { organizationId: previous.organizationId, repositoryId: previous.repositoryId, prNumber: previous.prNumber };
        const live = (await this.runs.findLive(key)).filter((r) => r.headSha === previous.headSha);
        if (live.length > 0) {
            throw new ConflictException(`Run ${live[0].runId} is still running for this commit`);
        }
        const sameSha = (await this.runs.list({ ...key, limit: 200 })).filter((r) => r.headSha === previous.headSha);
        const attempt = Math.max(previous.attempt, ...sameSha.map((r) => r.attempt)) + 1;

        const request = await this.requests.build({
            env: {
                environmentId: previous.environmentId,
                organizationId: target.organizationId,
                teamId: target.teamId,
                repositoryId: target.repositoryId,
                repositoryName: target.repositoryName,
            },
            prNumber: previous.prNumber,
            head,
            trigger: 'run_again',
            runId: deterministicUuid('run_again', previous.organizationId, previous.repositoryId, previous.prNumber, previous.headSha, attempt),
            attempt,
            ...(target.repositoryFullName ? { repositoryFullName: target.repositoryFullName } : {}),
        });
        await this.enqueuer.enqueue(request);
        return { runId: request.runId, attempt, state: 'queued' };
    }
}
