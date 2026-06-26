import { CockpitRangeQuery, SuggestionsImplementationRate } from '../types';

export const COCKPIT_CODE_HEALTH_SERVICE_TOKEN = Symbol.for(
    'CockpitCodeHealthService',
);

/**
 * Contract for the cockpit code-health warehouse queries. Consumers depend on
 * this interface + token rather than the concrete service, per the team's
 * DI-decoupling rule.
 */
export interface ICockpitCodeHealthService {
    getImplementationRate(
        q: Pick<CockpitRangeQuery, 'organizationId' | 'repository'> &
            Partial<Pick<CockpitRangeQuery, 'startDate' | 'endDate'>>,
    ): Promise<SuggestionsImplementationRate>;
}
