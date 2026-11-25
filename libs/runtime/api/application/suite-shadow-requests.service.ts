import { Inject, Injectable, Optional } from '@nestjs/common';

import { createLogger } from '@libs/core/log/logger';
import { OUTBOX_MESSAGE_REPOSITORY_TOKEN, type IOutboxMessageRepository } from '@libs/core/workflow/domain/contracts/outbox-message.repository.contract';
import { RuntimeCommandName, runtimeCommandOutboxMessage } from '@libs/runtime/contracts/runtime-commands';
import { traceparentFor } from '@libs/runtime/telemetry/runtime-telemetry';

import {
    RUNTIME_API_CONFIG,
    RUNTIME_CLOCK,
    RUNTIME_GIT_PORT,
    RUNTIME_PRODUCT_ENVIRONMENT_STORE,
    RUNTIME_RELEASE_GATE,
    RUNTIME_SUITE_SHADOW_READER,
    type Clock,
    type ProductEnvironmentStore,
    type RuntimeApiConfig,
    type RuntimeGitPort,
    type RuntimeReleaseGate,
    type RuntimeSuiteShadowReader,
    RUNTIME_ENVIRONMENT_SETUP_READER,
    type RuntimeEnvironmentSetupReader,
} from '../domain/ports';
import { RuntimeSuiteInputs } from './suite-inputs.service';
import { suiteOfRecipeAt } from './suite-recipe';

/** How many pending shadows one pass handles. */
const PASS_LIMIT = 20;

/**
 * Issues the `runtime.suite.requested` command (mode `shadow`) of the shadow a selected PR run asked for (docs/runtime/e2e-suites.md
 * section 6.1 Proof b, D14): the whole suite on the PR head in the background, compared with what the selection ran. The worker holds
 * no repository credentials, so it records the request (the PR, its head, the files it changed and removed, and the id the run will
 * have); this reads the queued ones, checks main's recipe still declares a suite, mints one download token per claim and writes the
 * command, sealed to the run's id. The shadow publishes nothing and gives no verdict: it only feeds the brake of the selection.
 */
@Injectable()
export class RuntimeSuiteShadowRequests {
    private readonly logger = createLogger(RuntimeSuiteShadowRequests.name);
    private readonly handled = new Set<string>();

    constructor(
        @Inject(RUNTIME_SUITE_SHADOW_READER) private readonly reader: RuntimeSuiteShadowReader,
        @Inject(RUNTIME_PRODUCT_ENVIRONMENT_STORE) private readonly environments: Pick<ProductEnvironmentStore, 'get'>,
        @Inject(RUNTIME_GIT_PORT) private readonly git: Pick<RuntimeGitPort, 'readFileAtCommit'>,
        @Inject(RuntimeSuiteInputs) private readonly inputs: Pick<RuntimeSuiteInputs, 'tokensFor'>,
        @Inject(OUTBOX_MESSAGE_REPOSITORY_TOKEN) private readonly outbox: Pick<IOutboxMessageRepository, 'create'>,
        @Inject(RUNTIME_CLOCK) private readonly now: Clock,
        @Inject(RUNTIME_API_CONFIG) private readonly config: RuntimeApiConfig,
        @Optional() @Inject(RUNTIME_RELEASE_GATE) private readonly release?: RuntimeReleaseGate,
        /** The environment's setup: its booted recipe is the suite's source when the repository has none committed. */
        @Optional() @Inject(RUNTIME_ENVIRONMENT_SETUP_READER) private readonly setups?: Pick<RuntimeEnvironmentSetupReader, 'get'>,
    ) {}

    /** Never throws: a shadow that cannot be issued is logged and left for the next pass. */
    async run(): Promise<{ pending: number; requested: number; skipped: number; failed: number }> {
        let pending;
        try {
            pending = await this.reader.pending(PASS_LIMIT);
        } catch (error) {
            this.logger.error({ message: 'Runtime suite shadows: pending read failed', context: RuntimeSuiteShadowRequests.name, error: error instanceof Error ? error : undefined });
            return { pending: 0, requested: 0, skipped: 0, failed: 1 };
        }
        let requested = 0;
        let skipped = 0;
        let failed = 0;
        for (const p of pending) {
            if (this.handled.has(p.shadowRunId)) {
                skipped++;
                continue;
            }
            try {
                const env = await this.environments.get(p.organizationId, p.environmentId);
                if (!env || (this.release && !(await this.release.isEnabledFor(p.organizationId)))) {
                    skipped++;
                    continue;
                }
                const repo = { organizationId: env.organizationId, teamId: env.teamId, repositoryId: env.repositoryId, repositoryName: env.repositoryName };
                const suite = await suiteOfRecipeAt(this.git, repo, p.mainSha, await this.setups?.get(p.organizationId, p.environmentId));
                if (!suite) {
                    // No suite at main any more: nothing to run, nothing minted. Not asked again by this process.
                    this.handled.add(p.shadowRunId);
                    skipped++;
                    continue;
                }
                const [repoToken, ...moreRepoTokens] = await this.inputs.tokensFor(repo, suite.shards, p.shadowRunId);
                await this.outbox.create(
                    runtimeCommandOutboxMessage(
                        RuntimeCommandName.SuiteRequested,
                        {
                            suiteRunId: p.shadowRunId,
                            organizationId: p.organizationId,
                            environmentId: p.environmentId,
                            repositoryId: p.repositoryId,
                            ...(env.repositoryName.includes('/') ? { repositoryFullName: env.repositoryName } : {}),
                            mode: 'shadow',
                            prNumber: p.prNumber,
                            prSha: p.prSha,
                            mergeBase: p.mergeBase,
                            mainSha: p.mainSha,
                            requestedAt: this.now().toISOString(),
                            key: p.shadowRunId,
                            traceparent: traceparentFor(p.shadowRunId),
                            repoToken,
                            moreRepoTokens,
                            ...(p.changedFiles.length ? { changedFiles: p.changedFiles } : {}),
                            ...(p.removedFiles.length ? { removedFiles: p.removedFiles } : {}),
                        },
                        p.shadowRunId,
                    ),
                );
                this.handled.add(p.shadowRunId);
                requested++;
            } catch (error) {
                failed++;
                this.logger.error({ message: 'Runtime suite shadow request failed', context: RuntimeSuiteShadowRequests.name, error: error instanceof Error ? error : undefined, metadata: { organizationId: p.organizationId, environmentId: p.environmentId } });
            }
        }
        return { pending: pending.length, requested, skipped, failed };
    }
}
