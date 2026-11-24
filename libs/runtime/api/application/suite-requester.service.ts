import { Inject, Injectable, Optional } from '@nestjs/common';

import { createLogger } from '@libs/core/log/logger';
import { OUTBOX_MESSAGE_REPOSITORY_TOKEN, type IOutboxMessageRepository } from '@libs/core/workflow/domain/contracts/outbox-message.repository.contract';
import { RUNTIME_RUN_TARGET_STORE_TOKEN, type RunTarget, type RunTargetStore } from '@libs/runtime-publish/domain/run-target';
import { sha256, uuidV5From } from '@libs/runtime/contracts/derive-id';
import { RuntimeCommandName, runtimeCommandOutboxMessage } from '@libs/runtime/contracts/runtime-commands';
import { traceparentFor } from '@libs/runtime/telemetry/runtime-telemetry';

import {
    RUNTIME_API_CONFIG,
    RUNTIME_CLOCK,
    RUNTIME_ENVIRONMENT_SETUP_READER,
    RUNTIME_GIT_PORT,
    RUNTIME_PRODUCT_ENVIRONMENT_STORE,
    RUNTIME_RELEASE_GATE,
    RUNTIME_REPO_TOKEN_ISSUER,
    type Clock,
    type ProductEnvironment,
    type ProductEnvironmentStore,
    type RuntimeApiConfig,
    type RuntimeEnvironmentSetupReader,
    type RuntimeGitPort,
    type RuntimeReleaseGate,
    type RuntimeRepoTokenIssuer,
} from '../domain/ports';
import { RUNTIME_PLATFORM_RESOLVER, type RuntimePlatformResolver } from './runtime-run-enqueuer.service';
import { RuntimeSuiteInputs } from './suite-inputs.service';
import { suiteOfRecipeAt } from './suite-recipe';

export type SuiteCiOutcome =
    | { status: 'requested'; suiteRunId: string }
    | { status: 'skipped'; reason: 'not_released' | 'no_pull_request' | 'not_open' | 'draft' | 'fork' | 'no_setup' | 'no_suite' };

/**
 * CI mode (docs/runtime/e2e-suites.md sections 2.2, 10.3 and 11): a pull request asks for the repository's own e2e suite, with
 * no Kody verdict, no probes and no PR comment, only the suite's check. The product reads what the Runtime may not: the PR's
 * head and files from the Git API (ADR-057, never the webhook), the recipe at the template's commit (how many claims, so how
 * many download tokens: the cell revokes a token once it fetched with it) and writes the publish target the check is written
 * under (`runtime_run_targets`, keyed by the suite run id) before the command. The same push is the same suite run (its id derives
 * from the PR and the head), so a trigger delivered twice starts one. A fork is not offered CI mode: its code waits for a maintainer.
 */
@Injectable()
export class RuntimeSuiteRequester {
    private readonly logger = createLogger(RuntimeSuiteRequester.name);

    constructor(
        @Inject(RUNTIME_PRODUCT_ENVIRONMENT_STORE) private readonly environments: Pick<ProductEnvironmentStore, 'get'>,
        @Inject(RUNTIME_GIT_PORT) private readonly git: Pick<RuntimeGitPort, 'getPullRequestHead' | 'getPullRequestDiff' | 'readFileAtCommit' | 'compareWithMain'>,
        @Inject(RUNTIME_REPO_TOKEN_ISSUER) private readonly repoTokens: RuntimeRepoTokenIssuer,
        @Inject(OUTBOX_MESSAGE_REPOSITORY_TOKEN) private readonly outbox: Pick<IOutboxMessageRepository, 'create'>,
        @Inject(RUNTIME_CLOCK) private readonly now: Clock,
        @Inject(RUNTIME_API_CONFIG) private readonly config: RuntimeApiConfig,
        @Inject(RUNTIME_ENVIRONMENT_SETUP_READER) private readonly setups: Pick<RuntimeEnvironmentSetupReader, 'get'>,
        @Inject(RUNTIME_RUN_TARGET_STORE_TOKEN) private readonly targets: Pick<RunTargetStore, 'record'>,
        @Inject(RUNTIME_PLATFORM_RESOLVER) private readonly platforms: RuntimePlatformResolver,
        @Optional() @Inject(RUNTIME_RELEASE_GATE) private readonly release?: RuntimeReleaseGate,
        @Optional() @Inject(RuntimeSuiteInputs) inputs?: RuntimeSuiteInputs,
    ) {
        this.inputs = inputs ?? new RuntimeSuiteInputs(git, repoTokens, config, setups);
    }

    private readonly inputs: RuntimeSuiteInputs;

    async requestCi(input: { environment: ProductEnvironment; prNumber: number }): Promise<SuiteCiOutcome> {
        const env = input.environment;
        if (this.release && !(await this.release.isEnabledFor(env.organizationId))) return { status: 'skipped', reason: 'not_released' };
        const orgTeam = { organizationId: env.organizationId, teamId: env.teamId };
        const repo = { repositoryId: env.repositoryId, repositoryName: env.repositoryName };
        const head = await this.git.getPullRequestHead({ ...orgTeam, ...repo, prNumber: input.prNumber });
        if (!head) return { status: 'skipped', reason: 'no_pull_request' };
        if (head.state && head.state !== 'open') return { status: 'skipped', reason: 'not_open' };
        // No timer on drafts (D13): the suite runs when the pull request turns ready for review.
        if (head.draft) return { status: 'skipped', reason: 'draft' };
        if (head.fork) return { status: 'skipped', reason: 'fork' };
        // The main side is the commit the environment's template was built from: the setup's.
        const mainSha = (await this.setups.get(env.organizationId, env.environmentId))?.sha;
        if (!mainSha) return { status: 'skipped', reason: 'no_setup' };
        const suite = await suiteOfRecipeAt(this.git, { ...orgTeam, ...repo }, mainSha);
        if (!suite) return { status: 'skipped', reason: 'no_suite' };
        const platform = await this.platforms.getTypeIntegration(orgTeam);
        if (!platform) return { status: 'skipped', reason: 'no_setup' };

        const suiteRunId = uuidV5From(sha256(`suite-ci:${env.organizationId}:${env.environmentId}:${input.prNumber}:${head.headSha}`));
        const diff = await this.git.getPullRequestDiff({ ...orgTeam, ...repo, prNumber: input.prNumber, headSha: head.headSha });
        // A diff the product had to cut says nothing of the files it left out: unknown, so the whole suite runs.
        const { changedFiles, removedFiles } = this.inputs.changesOf(diff);

        // The true merge base and how far main is past it (the compare API); the PR's own base and no count when the platform cannot say.
        const standing = await this.inputs.standingOf({ ...orgTeam, ...repo }, mainSha, head.headSha);

        // One token per claim: the spec listing, each shard, the fresh host and the main host.
        const tokens = await this.inputs.tokensFor({ ...orgTeam, ...repo }, suite.shards, suiteRunId);

        const target: RunTarget = {
            runId: suiteRunId,
            attempt: 1,
            organizationId: env.organizationId,
            teamId: env.teamId,
            repositoryId: env.repositoryId,
            repositoryName: env.repositoryName,
            ...(env.repositoryName.includes('/') ? { repositoryFullName: env.repositoryName } : {}),
            platform,
            pullRequestNumber: input.prNumber,
            headSha: head.headSha,
            fork: false,
        };
        await this.targets.record(target);
        await this.outbox.create(
            runtimeCommandOutboxMessage(
                RuntimeCommandName.SuiteRequested,
                {
                    suiteRunId,
                    organizationId: env.organizationId,
                    environmentId: env.environmentId,
                    repositoryId: env.repositoryId,
                    ...(env.repositoryName.includes('/') ? { repositoryFullName: env.repositoryName } : {}),
                    mode: 'ci',
                    prNumber: input.prNumber,
                    prSha: head.headSha,
                    mergeBase: standing.mergeBase ?? head.baseSha,
                    ...(standing.mainBehind !== undefined ? { mainBehind: standing.mainBehind } : {}),
                    mainSha,
                    requestedAt: this.now().toISOString(),
                    key: suiteRunId,
                    traceparent: traceparentFor(suiteRunId),
                    repoToken: tokens[0],
                    moreRepoTokens: tokens.slice(1),
                    ...(changedFiles ? { changedFiles } : {}),
                    ...(removedFiles ? { removedFiles } : {}),
                },
                suiteRunId,
            ),
        );
        this.logger.log({ message: 'Runtime suite requested (CI mode)', context: RuntimeSuiteRequester.name, metadata: { organizationId: env.organizationId, environmentId: env.environmentId, prNumber: input.prNumber } });
        return { status: 'requested', suiteRunId };
    }
}
