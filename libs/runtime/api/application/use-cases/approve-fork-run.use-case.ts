import {
    ConflictException,
    ForbiddenException,
    Inject,
    Injectable,
    NotFoundException,
} from '@nestjs/common';

import {
    IOutboxMessageRepository,
    OUTBOX_MESSAGE_REPOSITORY_TOKEN,
} from '@libs/core/workflow/domain/contracts/outbox-message.repository.contract';
import { Action } from '@libs/identity/domain/permissions/enums/permissions.enum';
import type { IUser } from '@libs/identity/domain/user/interfaces/user.interface';

import { RuntimeCommandName, runtimeCommandOutboxMessage } from '../../domain/runtime-commands';
import { RUNTIME_CLOCK, RUNTIME_GIT_PORT, type Clock, type GitIdentity, type PullRequestHead, type RuntimeGitPort } from '../../domain/ports';
import { RuntimeRunAccessService } from '../run-access.service';
import { RuntimeRunRequestBuilder } from '../run-request-builder.service';

const same = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

export function isPullRequestAuthor(identity: GitIdentity, head: PullRequestHead): boolean {
    return same(identity.id, head.authorId) || same(identity.login, head.authorLogin);
}

/**
 * POST /runtime/runs/:id/approvals — a maintainer approves a fork PR at the
 * head SHA it has now (ADR-030, ADR-057). The approver needs write on the repo
 * confirmed by the Git API, cannot be the PR author, and any doubt denies.
 * A push after the approval moves the head and asks again. The approval
 * carries fresh sealed tokens: the Run's own expired while it waited.
 */
@Injectable()
export class ApproveForkRunUseCase {
    constructor(
        private readonly access: RuntimeRunAccessService,
        @Inject(RUNTIME_GIT_PORT)
        private readonly git: RuntimeGitPort,
        @Inject(OUTBOX_MESSAGE_REPOSITORY_TOKEN)
        private readonly outbox: IOutboxMessageRepository,
        @Inject(RUNTIME_CLOCK)
        private readonly now: Clock,
        private readonly requests: RuntimeRunRequestBuilder,
    ) {}

    async execute(input: { user: Partial<IUser>; runId: string }) {
        // Approving starts a Run on a fork's code: a write, checked as Create on the Run (like "Run again").
        const run = await this.access.load({ kind: 'user', user: input.user }, input.runId, Action.Create);
        if (run.state !== 'awaiting_approval') {
            throw new ConflictException('This Run is not waiting for an approval');
        }

        const orgTeam = { organizationId: run.organizationId, teamId: run.teamId };
        const repo = { repositoryId: run.repositoryId, repositoryName: run.repositoryName };
        const head = await this.git.getPullRequestHead({ ...orgTeam, ...repo, prNumber: run.prNumber });
        if (!head) throw new NotFoundException('Pull request not found');
        if (head.headSha !== run.headSha) {
            throw new ConflictException('The pull request has a newer head; approve the new Run');
        }

        const identity = await this.git.resolveGitIdentity({ ...orgTeam, userId: input.user.uuid!, email: input.user.email });
        if (!identity || (!identity.id && !identity.login)) {
            throw new ForbiddenException('Your Git account could not be identified for this repository');
        }
        if (isPullRequestAuthor(identity, head)) {
            throw new ForbiddenException('The author of the pull request cannot approve it');
        }

        let canWrite: boolean | undefined;
        try {
            canWrite = await this.git.userCanWrite({ ...orgTeam, ...repo, identity });
        } catch {
            canWrite = undefined;
        }
        if (canWrite !== true) {
            throw new ForbiddenException('Approving a fork Run needs write access to the repository');
        }

        // Minted only once every check passed; no seal key means no approval (nothing plain is sent).
        const tokens = await this.requests.mintTokens({
            ...orgTeam,
            ...repo,
            runId: run.runId,
            attempt: run.attempt,
            prNumber: run.prNumber,
            fork: true,
        });
        const approvedAt = this.now().toISOString();
        const key = `${run.runId}:${run.headSha}`;
        await this.outbox.create(
            runtimeCommandOutboxMessage(
                RuntimeCommandName.ForkApproved,
                {
                    runId: run.runId,
                    attempt: run.attempt,
                    organizationId: run.organizationId,
                    repositoryId: run.repositoryId,
                    prNumber: run.prNumber,
                    headSha: run.headSha,
                    approver: {
                        userId: input.user.uuid!,
                        ...(identity.id ? { gitUserId: identity.id } : {}),
                        ...(identity.login ? { gitLogin: identity.login } : {}),
                    },
                    approvedAt,
                    tokens,
                    key,
                },
                key,
            ),
        );
        return { runId: run.runId, headSha: run.headSha, approvedAt };
    }
}
