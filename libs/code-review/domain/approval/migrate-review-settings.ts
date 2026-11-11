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

/** Resolve just activation without merging/parsing unrelated review settings. */
export function resolveRiskActivation(
    defaults: DeepPartial<CodeReviewConfig>,
    ...sources: object[]
) {
    let approvalActive = !!defaults.pullRequestApprovalActive;
    let choice: { independent: boolean; active: boolean } | undefined;
    let source: 'legacy' | 'independent' = 'legacy';
    for (const raw of sources) {
        const layer = raw as Partial<CodeReviewConfig>;
        if (own(raw, 'pullRequestApprovalActive'))
            approvalActive = !!layer.pullRequestApprovalActive;
        if (own(raw, 'riskAssessmentActive') || own(raw, 'riskCriteria'))
            source = 'independent';
        if (own(raw, 'riskAssessmentActive')) {
            if (typeof layer.riskAssessmentActive !== 'boolean')
                throw new Error('Invalid risk assessment setting.');
            choice = { independent: true, active: layer.riskAssessmentActive };
        } else if (own(raw, 'approvalRiskActive')) {
            choice = { independent: false, active: !!layer.approvalRiskActive };
        }
    }
    return {
        source,
        active: choice
            ? choice.active && (choice.independent || approvalActive)
            : approvalActive && !!defaults.approvalRiskActive,
    };
}

/** Translate aliases at their source priority, before defaults or lower canonical fields can mask them. */
export function resolveReviewSettings(
    defaults: DeepPartial<CodeReviewConfig>,
    ...sources: object[]
): CodeReviewConfig {
    const effective = deepMerge(defaults, ...sources) as CodeReviewConfig;
    const saved = deepMerge(...sources) as Partial<CodeReviewConfig>;
    const riskActivation = resolveRiskActivation(defaults, ...sources);
    let approvalPolicySource: 'legacy' | 'named' = 'legacy';
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
    let legacyRoutingMode = defaults.reviewMode;
    for (const source of sources) {
        const layer = source as Partial<CodeReviewConfig>;
        if (own(source, 'riskReviewRouting')) {
            riskReviewRoutingSchema.parse(layer.riskReviewRouting);
        } else if (own(source, 'reviewMode')) {
            // Once this source uses canonical routing, its default review mode
            // no longer owns a route. An empty object means inherit the routes.
            legacyRoutingMode = layer.reviewMode;
        }
        if (own(source, 'riskCriteria'))
            criteria = riskCriteriaSchema.parse(layer.riskCriteria);
        else if (own(source, 'approvalRiskInstructions')) {
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
        if (own(source, 'approvalPolicies')) {
            approvalPolicySource = 'named';
            policies = approvalPoliciesSchema.parse(layer.approvalPolicies);
        } else if (
            own(source, 'approvalLabels') ||
            own(source, 'approvalAuthors')
        ) {
            let hasLegacyPolicy = false;
            policies = policies.map((policy) => {
                if (policy.id !== 'legacy-approval') return policy;
                hasLegacyPolicy = true;
                return {
                    ...policy,
                    ...(own(source, 'approvalLabels')
                        ? { labels: layer.approvalLabels }
                        : {}),
                    ...(own(source, 'approvalAuthors')
                        ? { authors: layer.approvalAuthors }
                        : {}),
                };
            });
            if (
                !hasLegacyPolicy &&
                (layer.approvalLabels?.length || layer.approvalAuthors?.length)
            )
                throw new Error(
                    'Legacy approval filters cannot scope named policies. Use approvalPolicies in this configuration source.',
                );
        }
    }
    return {
        ...effective,
        approvalPolicySource,
        riskAssessmentSource: riskActivation.source,
        riskAssessmentActive: riskActivation.active,
        riskCriteria: criteria,
        approvalPolicies: policies,
        riskReviewRouting: {
            noRisk: legacyRoutingMode === 'heavy' ? 'heavy' : 'balanced',
            riskFound: 'heavy',
            ...saved.riskReviewRouting,
        },
    };
}

/** Migration exposes policies in settings without changing legacy execution semantics. */
export function usesNamedApprovalPolicies(config?: Partial<CodeReviewConfig>) {
    return (
        config?.approvalPolicies !== undefined &&
        config.approvalPolicySource !== 'legacy'
    );
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
