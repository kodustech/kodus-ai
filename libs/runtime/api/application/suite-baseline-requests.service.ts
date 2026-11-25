import { Inject, Injectable, Optional } from '@nestjs/common';

import { createLogger } from '@libs/core/log/logger';
import {
    OUTBOX_MESSAGE_REPOSITORY_TOKEN,
    type IOutboxMessageRepository,
} from '@libs/core/workflow/domain/contracts/outbox-message.repository.contract';
import { RuntimeCommandName, runtimeCommandOutboxMessage } from '@libs/runtime/contracts/runtime-commands';
import { traceparentFor } from '@libs/runtime/telemetry/runtime-telemetry';

import {
    RUNTIME_API_CONFIG,
    RUNTIME_CLOCK,
    RUNTIME_GIT_PORT,
    RUNTIME_PRODUCT_ENVIRONMENT_STORE,
    RUNTIME_RELEASE_GATE,
    RUNTIME_REPO_TOKEN_ISSUER,
    RUNTIME_SUITE_BASELINE_READER,
    type Clock,
    type ProductEnvironmentStore,
    type RuntimeApiConfig,
    type RuntimeGitPort,
    type RuntimeReleaseGate,
    type RuntimeRepoTokenIssuer,
    type RuntimeSuiteBaselineReader,
    RUNTIME_ENVIRONMENT_SETUP_READER,
    type RuntimeEnvironmentSetupReader,
} from '../domain/ports';
import { sealForRuntime } from './secret-sealer';
import { suiteOfRecipeAt } from './suite-recipe';

/** How many pending baseline requests one pass handles. */
const PASS_LIMIT = 50;

/**
 * Issues the `runtime.suite.requested` command of the baseline suite runs a template turning ready asked for
 * (docs/runtime/e2e-suites.md section 2.1). The fleet holds no repository credentials, so it records the request (the main commit,
 * and the id its suite run will have); this reads the queued ones, checks the recipe at that commit still declares a suite with
 * a baseline, mints the download tokens and writes the command, sealed to the run's id. The cell revokes a token once it fetched
 * with it, so the command carries one per claim: the spec listing and each shard (a baseline has no re-run). The worker starts a
 * suite once per run id and marks the request started, which takes it out of the queue; a repeat here only saves minting tokens again.
 */
@Injectable()
export class RuntimeSuiteBaselineRequests {
    private readonly logger = createLogger(RuntimeSuiteBaselineRequests.name);
    private readonly handled = new Set<string>();

    constructor(
        @Inject(RUNTIME_SUITE_BASELINE_READER) private readonly reader: RuntimeSuiteBaselineReader,
        @Inject(RUNTIME_PRODUCT_ENVIRONMENT_STORE) private readonly environments: Pick<ProductEnvironmentStore, 'get'>,
        @Inject(RUNTIME_GIT_PORT) private readonly git: Pick<RuntimeGitPort, 'readFileAtCommit'>,
        @Inject(RUNTIME_REPO_TOKEN_ISSUER) private readonly repoTokens: RuntimeRepoTokenIssuer,
        @Inject(OUTBOX_MESSAGE_REPOSITORY_TOKEN) private readonly outbox: Pick<IOutboxMessageRepository, 'create'>,
        @Inject(RUNTIME_CLOCK) private readonly now: Clock,
        @Inject(RUNTIME_API_CONFIG) private readonly config: RuntimeApiConfig,
        @Optional() @Inject(RUNTIME_RELEASE_GATE) private readonly release?: RuntimeReleaseGate,
        /** The environment's setup: its booted recipe is the suite's source when the repository has none committed. */
        @Optional() @Inject(RUNTIME_ENVIRONMENT_SETUP_READER) private readonly setups?: Pick<RuntimeEnvironmentSetupReader, 'get'>,
    ) {}

    /** Never throws: a request that cannot be issued is logged and left for the next pass. */
    async run(): Promise<{ pending: number; requested: number; skipped: number; failed: number }> {
        let pending;
        try {
            pending = await this.reader.pending(PASS_LIMIT);
        } catch (error) {
            this.logger.error({ message: 'Runtime suite baselines: pending read failed', context: RuntimeSuiteBaselineRequests.name, error: error instanceof Error ? error : undefined });
            return { pending: 0, requested: 0, skipped: 0, failed: 1 };
        }
        let requested = 0;
        let skipped = 0;
        let failed = 0;
        for (const p of pending) {
            if (this.handled.has(p.suiteRunId)) {
                skipped++;
                continue;
            }
            try {
                const env = await this.environments.get(p.organizationId, p.environmentId);
                if (!env || (this.release && !(await this.release.isEnabledFor(p.organizationId)))) {
                    skipped++;
                    continue;
                }
                const orgTeam = { organizationId: env.organizationId, teamId: env.teamId };
                const repo = { repositoryId: env.repositoryId, repositoryName: env.repositoryName };
                const suite = await suiteOfRecipeAt(this.git, { ...orgTeam, ...repo }, p.mainSha, await this.setups?.get(p.organizationId, p.environmentId));
                const shards = suite?.baseline ? suite.shards : undefined;
                if (shards === undefined) {
                    // No suite at that commit: nothing to run, and nothing minted. Not asked again by this process.
                    this.handled.add(p.suiteRunId);
                    skipped++;
                    continue;
                }
                const tokens: string[] = [];
                for (let i = 0; i <= shards; i++) tokens.push(sealForRuntime(this.config, await this.repoTokens.issue({ ...orgTeam, ...repo }), p.suiteRunId));
                await this.outbox.create(
                    runtimeCommandOutboxMessage(
                        RuntimeCommandName.SuiteRequested,
                        {
                            suiteRunId: p.suiteRunId,
                            organizationId: p.organizationId,
                            environmentId: p.environmentId,
                            repositoryId: p.repositoryId,
                            ...(env.repositoryName.includes('/') ? { repositoryFullName: env.repositoryName } : {}),
                            mode: 'baseline',
                            mainSha: p.mainSha,
                            requestedAt: this.now().toISOString(),
                            key: p.suiteRunId,
                            traceparent: traceparentFor(p.suiteRunId),
                            repoToken: tokens[0],
                            moreRepoTokens: tokens.slice(1),
                        },
                        p.suiteRunId,
                    ),
                );
                this.handled.add(p.suiteRunId);
                requested++;
            } catch (error) {
                failed++;
                this.logger.error({ message: 'Runtime suite baseline request failed', context: RuntimeSuiteBaselineRequests.name, error: error instanceof Error ? error : undefined, metadata: { organizationId: p.organizationId, environmentId: p.environmentId } });
            }
        }
        return { pending: pending.length, requested, skipped, failed };
    }
}
