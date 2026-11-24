import { Inject, Injectable } from '@nestjs/common';

import { createLogger } from '@libs/core/log/logger';
import type { RuntimePullRequestObserved } from '@libs/runtime/run';

import { RUNTIME_API_CONFIG, RUNTIME_PRODUCT_ENVIRONMENT_STORE, type ProductEnvironmentStore, type RuntimeApiConfig } from '../domain/ports';
import { RuntimeSuiteRequester, type SuiteCiOutcome } from './suite-requester.service';

/** The pull request events that ask for the suite: a new head, or a pull request that just became reviewable. */
const CI_EVENTS: ReadonlySet<RuntimePullRequestObserved['event']> = new Set(['opened', 'reopened', 'ready_for_review', 'synchronize']);

/**
 * CI mode's trigger (docs/runtime/e2e-suites.md section 11): the PR's own events, read by the Run trigger, ask for the suite of
 * the environment the repository is the primary of. Off unless `RUNTIME_SUITE_CI=true`. It never throws and never changes what
 * the Run trigger decided: a suite that cannot be asked for is logged.
 */
@Injectable()
export class RuntimeSuiteCiTrigger {
    private readonly logger = createLogger(RuntimeSuiteCiTrigger.name);

    constructor(
        @Inject(RUNTIME_API_CONFIG) private readonly config: Pick<RuntimeApiConfig, 'suiteCi'>,
        @Inject(RUNTIME_PRODUCT_ENVIRONMENT_STORE) private readonly environments: Pick<ProductEnvironmentStore, 'findByRepository'>,
        @Inject(RuntimeSuiteRequester) private readonly requester: Pick<RuntimeSuiteRequester, 'requestCi'>,
    ) {}

    async onPullRequest(ev: RuntimePullRequestObserved): Promise<SuiteCiOutcome | { status: 'skipped'; reason: 'disabled' | 'event' | 'no_environment' | 'failed' }> {
        if (!this.config.suiteCi) return { status: 'skipped', reason: 'disabled' };
        if (!CI_EVENTS.has(ev.event)) return { status: 'skipped', reason: 'event' };
        try {
            const environment = await this.environments.findByRepository(ev.organizationId, ev.repository.id);
            if (!environment) return { status: 'skipped', reason: 'no_environment' };
            return await this.requester.requestCi({ environment, prNumber: ev.prNumber });
        } catch (error) {
            this.logger.warn({ message: 'Runtime suite CI trigger failed', context: RuntimeSuiteCiTrigger.name, error: error instanceof Error ? error : undefined, metadata: { organizationId: ev.organizationId, repositoryId: ev.repository.id, prNumber: ev.prNumber } });
            return { status: 'skipped', reason: 'failed' };
        }
    }
}
