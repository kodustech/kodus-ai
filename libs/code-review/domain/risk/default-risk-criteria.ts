import {
    DEFAULT_RISK_CRITERION_PREFIX,
    type RiskCriterion,
} from '@libs/core/infrastructure/config/types/general/risk-assessment';

/** A rule as the assessment applies it: defaults and overrides resolved. */
export type EffectiveRiskCriterion = RiskCriterion & {
    name: string;
    instructions: string;
    /** A Kodus default, possibly overridden by the team. */
    isDefault: boolean;
};

/**
 * What Kodus treats as needing a person when no team says otherwise. Teams
 * see these rules, can edit or turn any of them off, and add their own; an
 * edited or disabled default is stored by its id in the team's config.
 */
export const DEFAULT_RISK_CRITERIA: ReadonlyArray<
    RiskCriterion & { name: string; instructions: string }
> = [
    {
        id: 'kodus-security',
        name: 'Security and permissions',
        enabled: true,
        instructions:
            'A change to authentication, authorization or permissions, tenant isolation, input validation, or any check that protects data or actions.',
    },
    {
        id: 'kodus-money',
        name: 'Money, billing and licensing',
        enabled: true,
        instructions:
            'A change to payments, prices, charges, credits, invoices, subscriptions or licensing.',
    },
    {
        id: 'kodus-data',
        name: 'Stored data and migrations',
        enabled: true,
        instructions:
            'A data or schema migration, deleting or rewriting stored data, or a change to the shape of persisted data or to the queries that read or write it.',
    },
    {
        id: 'kodus-infrastructure',
        name: 'Secrets and infrastructure',
        enabled: true,
        instructions:
            'A change to secrets, credentials, infrastructure, networking or the environment the product runs in.',
    },
    {
        id: 'kodus-ci-build',
        name: 'CI, build, release and dependencies',
        enabled: true,
        instructions:
            'A change to CI, build, release or deploy configuration, or to a dependency or tool version, which every later change is checked or shipped with.',
    },
    {
        id: 'kodus-shared-contract',
        name: 'Shared contracts and public interfaces',
        enabled: true,
        instructions:
            'A change to what other code, users or integrations already rely on: the results of a public API, library function or CLI, or a contract shared across modules.',
    },
    {
        id: 'kodus-concurrency',
        name: 'Concurrency, retries, queues and caching',
        enabled: true,
        instructions:
            'A change to concurrency, locking, retries, queues, scheduling or caching.',
    },
    {
        id: 'kodus-ai-behavior',
        name: 'Production prompts and model behavior',
        enabled: true,
        instructions:
            'A change to the prompts, model choice or model settings a production feature runs with.',
    },
    {
        id: 'kodus-broad-change',
        name: 'Broad or mixed changes',
        enabled: true,
        instructions:
            'A broad rewrite of core paths, or one PR that mixes several consequential changes.',
    },
];

const DEFAULTS_BY_ID = new Map(
    DEFAULT_RISK_CRITERIA.map((criterion) => [criterion.id, criterion]),
);

/**
 * The defaults with the team's overrides applied, then the team's own rules.
 * A `kodus-` id is always an override: one of a default Kodus no longer ships
 * is dropped, whatever it holds, so retiring a default never fails a stored
 * config. A team rule without a name or instructions is dropped too.
 */
export function effectiveRiskCriteria(
    team: readonly RiskCriterion[] | undefined,
): EffectiveRiskCriterion[] {
    const overrides = new Map(
        (team ?? [])
            .filter((criterion) => DEFAULTS_BY_ID.has(criterion.id))
            .map((criterion) => [criterion.id, criterion]),
    );
    const defaults = DEFAULT_RISK_CRITERIA.map((base) => {
        const override = overrides.get(base.id);
        return {
            ...base,
            ...(override
                ? Object.fromEntries(
                      Object.entries(override).filter(
                          ([, value]) => value !== undefined,
                      ),
                  )
                : {}),
            isDefault: true,
        } as EffectiveRiskCriterion;
    });
    const own = (team ?? []).flatMap((criterion) =>
        !criterion.id.startsWith(DEFAULT_RISK_CRITERION_PREFIX) &&
        criterion.name &&
        criterion.instructions
            ? [
                  {
                      ...criterion,
                      name: criterion.name,
                      instructions: criterion.instructions,
                      isDefault: false,
                  },
              ]
            : [],
    );
    return [...defaults, ...own];
}
