import type { Pool } from 'pg';

import type { AmqpConnection } from '@golevelup/nestjs-rabbitmq';

import type { EvidenceStore } from '../../shared/evidence/file-evidence-store';
import { PgEnvTemplates } from '../../shared/persistence/env-templates';
import { PgHostPoolReader } from '../../shared/persistence/host-pools';
import { PgSuiteBaselineRequests } from '../../shared/persistence/suite-baseline-requests';
import { PgSuiteDemand } from '../../shared/persistence/suite-demand';
import type { RunDependenciesFactory } from '../dbos/run-deps.factory';
import { AmqpSuitePublishRequester } from '../publish/amqp-suite-publish-requester';
import type { EnvironmentSetupStore } from '../setup/environment-setup.store';
import { PgSuiteBaselines } from './pg-suite-baselines';
import { PgSuiteCoverageMaps } from './pg-suite-coverage-maps';
import type { PgSuiteRuns } from './pg-suite-runs';
import { PgSuiteSpecStats } from './pg-suite-spec-stats';
import { PlacementSuiteDemand } from './suite-adapters';
import { SuitePublisher } from './suite-publisher';
import { SuiteService } from './suite-service';

/**
 * The one suite service both modes run: the `runtime.suite` workflow (CI mode and the baseline) and the Run's stage (Run mode)
 * are built from it, so "one engine, two triggers" holds in production wiring as well as in the design.
 */
export function buildSuiteService(d: {
    pool: Pool;
    deps: Pick<RunDependenciesFactory, 'envForSuite'>;
    setups: Pick<EnvironmentSetupStore, 'get'>;
    runs: PgSuiteRuns;
    amqp: Pick<AmqpConnection, 'publish'>;
    /** RUNTIME_SUITE_MAX_HOSTS: the hosts one suite run asks for at most. */
    maxHosts: number;
    /** The evidence store the artifacts of failed specs are written to; absent: none are kept. */
    evidence?: Pick<EvidenceStore, 'put'>;
}): SuiteService {
    const templates = new PgEnvTemplates(d.pool);
    const pools = new PgHostPoolReader(d.pool);
    const demand = new PgSuiteDemand(d.pool);
    return new SuiteService({
        setups: d.setups,
        environment: (ctx) => d.deps.envForSuite(ctx),
        demand: (scope) => new PlacementSuiteDemand(demand, pools, scope),
        runs: d.runs,
        stats: new PgSuiteSpecStats(d.pool),
        baselines: new PgSuiteBaselines(d.pool),
        maps: new PgSuiteCoverageMaps(d.pool),
        ...(d.evidence ? { evidence: d.evidence } : {}),
        templates: { hasReady: (organizationId, environmentId) => templates.hasReady(organizationId, environmentId) },
        headroom: async () => d.maxHosts,
        baselineRequests: new PgSuiteBaselineRequests(d.pool),
        // The suite's own check goes to the product on the Runtime's publish route.
        publisher: new SuitePublisher(d.runs, new AmqpSuitePublishRequester(d.amqp)),
        clock: { now: () => Date.now(), sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)) },
    });
}
