import { deepDifference, deepMerge } from '@libs/common/utils/deep';
import type { DeepPartial } from 'typeorm';
import type { CodeReviewConfig } from '@libs/core/infrastructure/config/types/general/codeReview.type';
import {
    approvalPoliciesSchema,
    type NamedApprovalPolicy,
} from '@libs/core/infrastructure/config/types/general/approval-policies';
import {
    riskCriteriaSchema,
    riskReviewRoutingSchema,
    type RiskCriterion,
} from '@libs/core/infrastructure/config/types/general/risk-assessment';

type Settings = Pick<
    CodeReviewConfig,
    | 'riskAssessmentActive'
    | 'riskCriteria'
    | 'riskReviewRouting'
    | 'approvalPolicies'
>;
const keys: Array<keyof Settings> = [
    'riskAssessmentActive',
    'riskCriteria',
    'riskReviewRouting',
    'approvalPolicies',
];
const own = (source: object, key: string) =>
    Object.prototype.hasOwnProperty.call(source, key) &&
    (source as Record<string, unknown>)[key] !== undefined;

/** Translate aliases at their source priority, before defaults or lower canonical fields can mask them. */
export function resolveReviewSettings(
    defaults: DeepPartial<CodeReviewConfig>,
    ...sources: object[]
): CodeReviewConfig {
    const effective = deepMerge(defaults, ...sources) as CodeReviewConfig;
    const saved = deepMerge(...sources) as Partial<CodeReviewConfig>;
    let riskChoice: { independent: boolean; active: boolean } | undefined;
    let policies: NamedApprovalPolicy[] = approvalPoliciesSchema.parse([
        {
            id: 'legacy-approval',
            name: 'Existing approval policy',
            enabled: true,
            labels: defaults.approvalLabels ?? [],
            authors: defaults.approvalAuthors ?? [],
        },
    ]);
    let criteria: RiskCriterion[] = [];
    for (const source of sources) {
        const layer = source as Partial<CodeReviewConfig>;
        if (own(source, 'riskAssessmentActive')) {
            if (typeof layer.riskAssessmentActive !== 'boolean')
                throw new Error('Invalid risk assessment setting.');
            riskChoice = {
                independent: true,
                active: layer.riskAssessmentActive,
            };
        } else if (own(source, 'approvalRiskActive'))
            riskChoice = {
                independent: false,
                active: !!layer.approvalRiskActive,
            };
        if (own(source, 'riskReviewRouting'))
            riskReviewRoutingSchema.parse(layer.riskReviewRouting);
        if (own(source, 'riskCriteria'))
            criteria = riskCriteriaSchema.parse(layer.riskCriteria);
        else if (own(source, 'approvalRiskInstructions')) {
            if (!Array.isArray(criteria))
                throw new Error('Invalid risk criteria.');
            criteria = criteria.filter(
                (criterion) => criterion.id !== 'legacy-risk',
            );
            const instruction = layer.approvalRiskInstructions?.trim();
            if (instruction)
                criteria = [
                    ...criteria,
                    {
                        id: 'legacy-risk',
                        name: 'Team context',
                        enabled: true,
                        instructions: instruction,
                    },
                ];
        }
        if (own(source, 'approvalPolicies'))
            policies = approvalPoliciesSchema.parse(layer.approvalPolicies);
        else if (
            own(source, 'approvalLabels') ||
            own(source, 'approvalAuthors')
        ) {
            if (!Array.isArray(policies))
                throw new Error('Invalid approval policies.');
            const legacy = policies.findIndex(
                (policy) => policy.id === 'legacy-approval',
            );
            if (legacy === -1) {
                if (
                    layer.approvalLabels?.length ||
                    layer.approvalAuthors?.length
                )
                    throw new Error(
                        'Legacy approval filters cannot scope named policies. Use approvalPolicies in this configuration source.',
                    );
            } else {
                policies = policies.map((policy, index) =>
                    index !== legacy
                        ? policy
                        : {
                              ...policy,
                              ...(own(source, 'approvalLabels')
                                  ? { labels: layer.approvalLabels }
                                  : {}),
                              ...(own(source, 'approvalAuthors')
                                  ? { authors: layer.approvalAuthors }
                                  : {}),
                          },
                );
            }
        }
    }
    return {
        ...effective,
        riskAssessmentActive: riskChoice
            ? riskChoice.active &&
              (riskChoice.independent || !!effective.pullRequestApprovalActive)
            : !!effective.pullRequestApprovalActive &&
              !!effective.approvalRiskActive,
        riskCriteria: criteria,
        approvalPolicies: policies,
        riskReviewRouting: {
            noRisk: effective.reviewMode === 'heavy' ? 'heavy' : 'balanced',
            riskFound: 'heavy',
            ...saved.riskReviewRouting,
        },
    };
}

/** Used when a caller already has an effective legacy configuration and its raw saved delta. */
export function migratedReviewSettings(
    effective: Partial<CodeReviewConfig>,
    saved: Partial<CodeReviewConfig> = effective,
): Settings {
    const resolved = resolveReviewSettings(effective, saved);
    return Object.fromEntries(
        keys.map((key) => [key, resolved[key]]),
    ) as Settings;
}

/** Formatting only: derive a scope's view without writing inherited policies back to storage. */
export function migratedReviewLayer(
    defaults: DeepPartial<CodeReviewConfig>,
    parents: object[],
    child: object | undefined,
) {
    if (!child) return undefined;
    const parent = resolveReviewSettings(defaults, ...parents);
    const next = resolveReviewSettings(defaults, ...parents, child);
    const before = Object.fromEntries(keys.map((key) => [key, parent[key]]));
    const after = Object.fromEntries(keys.map((key) => [key, next[key]]));
    return { ...child, ...deepDifference(before, after) };
}
