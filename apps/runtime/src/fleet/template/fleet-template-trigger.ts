import type { Pool } from 'pg';

import { PgEnvironmentSetupReads } from '@libs/runtime/run/adapters/pg-environment-setup.store';

import { PgSuiteBaselineRequests } from '../../shared/persistence/suite-baseline-requests';
import { TemplateBuildTrigger, type TemplateTriggerDeps } from './template-trigger';

/**
 * The template trigger as the fleet runs it. What to template comes from the environment's own setup
 * (runtime_environment_setups, by environment id): a template build's setup record lives in another table, keyed by
 * its setup key, and reading that one here finds nothing, so no template is ever built.
 */
export function fleetTemplateTrigger(pool: Pick<Pool, 'query'>, d: Omit<TemplateTriggerDeps, 'environmentSetups' | 'baselines'>): TemplateBuildTrigger {
    return new TemplateBuildTrigger({
        ...d,
        environmentSetups: new PgEnvironmentSetupReads(pool),
        // A template that turns ready asks for a baseline of its main commit (e2e suites, section 2.1).
        baselines: new PgSuiteBaselineRequests(pool),
    });
}
