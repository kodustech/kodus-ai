import { ConflictException, Inject, Injectable } from '@nestjs/common';

import type { IUser } from '@libs/identity/domain/user/interfaces/user.interface';
import { OUTBOX_MESSAGE_REPOSITORY_TOKEN, type IOutboxMessageRepository } from '@libs/core/workflow/domain/contracts/outbox-message.repository.contract';
import { RUNTIME_RUN_TARGET_STORE_TOKEN, type RunTargetStore } from '@libs/runtime-publish/domain/run-target';
import { sha256, uuidV5From } from '@libs/runtime/contracts/derive-id';
import { RuntimeCommandName, runtimeCommandOutboxMessage } from '@libs/runtime/contracts/runtime-commands';
import type { RuntimeRunProjection } from '@libs/runtime/run';

import { RUNTIME_CLOCK, RUNTIME_GIT_PORT, type Clock, type RuntimeGitPort } from '../domain/ports';
import { RuntimeSuiteInputs } from './suite-inputs.service';
import { suiteOfRecipeAt } from './suite-recipe';

/**
 * "Re-run failed" (docs/runtime/e2e-suites.md section 11): the specs of a finished suite run that did not pass, run again as a suite run of
 * their own. The product holds what the Runtime may not: it mints one sealed download token per claim (the cell revokes a token once it
 * fetched with it) exactly as CI mode does, and stores the PR the retry's check is written to under the retry's id before the command. The
 * same minute is the same retry (its key derives from the suite run and the minute), so a double click starts one.
 */
@Injectable()
export class RuntimeSuiteRetrier {
    constructor(
        @Inject(RUNTIME_GIT_PORT) private readonly git: Pick<RuntimeGitPort, 'readFileAtCommit'>,
        @Inject(RuntimeSuiteInputs) private readonly inputs: Pick<RuntimeSuiteInputs, 'tokensFor'>,
        @Inject(OUTBOX_MESSAGE_REPOSITORY_TOKEN) private readonly outbox: Pick<IOutboxMessageRepository, 'create'>,
        @Inject(RUNTIME_CLOCK) private readonly now: Clock,
        @Inject(RUNTIME_RUN_TARGET_STORE_TOKEN) private readonly targets: Pick<RunTargetStore, 'get' | 'record'>,
    ) {}

    async retryFailed(input: { user: Partial<IUser>; run: Pick<RuntimeRunProjection, 'runId' | 'organizationId' | 'teamId' | 'repositoryId' | 'repositoryName'>; suiteRunId: string; mainSha: string }): Promise<{ suiteRunId: string }> {
        const { run } = input;
        const repo = { organizationId: run.organizationId, teamId: run.teamId, repositoryId: run.repositoryId, repositoryName: run.repositoryName };
        const suite = await suiteOfRecipeAt(this.git, repo, input.mainSha);
        if (!suite) throw new ConflictException("This environment's recipe no longer declares an e2e suite, so its failed specs cannot be run again");
        // Where the Run publishes: its target is what the retry's check is written to (the retry is a suite run of its own).
        const target = await this.targets.get(run.runId, { organizationId: run.organizationId });
        if (!target) throw new ConflictException('The Run has no target recorded by the product');

        const at = this.now();
        const key = `suite-retry:${input.suiteRunId}:failed:${at.toISOString().slice(0, 16)}`;
        const retryRunId = uuidV5From(sha256(`suite-retry:${run.organizationId}:${key}`));
        const [repoToken, ...moreRepoTokens] = await this.inputs.tokensFor(repo, suite.shards, key);
        await this.targets.record({ ...target, runId: retryRunId, attempt: 1 });
        await this.outbox.create(
            runtimeCommandOutboxMessage(
                RuntimeCommandName.SuiteRetried,
                {
                    suiteRunId: input.suiteRunId,
                    organizationId: run.organizationId,
                    scope: 'failed',
                    requestedBy: { userId: input.user.uuid!, ...(input.user.email ? { email: input.user.email } : {}) },
                    requestedAt: at.toISOString(),
                    key,
                    ...(target.repositoryFullName ? { repositoryFullName: target.repositoryFullName } : run.repositoryName.includes('/') ? { repositoryFullName: run.repositoryName } : {}),
                    repoToken,
                    moreRepoTokens,
                },
                retryRunId,
            ),
        );
        return { suiteRunId: retryRunId };
    }
}
