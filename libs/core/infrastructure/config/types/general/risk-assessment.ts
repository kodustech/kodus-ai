import { z } from 'zod';
import { filePatternListSchema } from './file-pattern-schema';
import {
    DEFAULT_RISK_CRITERION_PREFIX,
    isKnownKodusRiskRuleId,
} from './risk-rule-ids';

export { DEFAULT_RISK_CRITERION_PREFIX };

/** Request metadata for restoring a scoped setting, never stored in config. */
export const REVIEW_SETTINGS_INHERITABLE_FIELDS = [
    'riskAssessmentActive',
    'riskCriteria',
    'approvalPolicies',
    'reviewMode',
    'riskReviewRouting.noRisk',
    'riskReviewRouting.riskFound',
] as const;

/**
 * A risk rule: what the team treats as needing a person, scoped by file
 * filters. An entry whose id is a Kodus default's overrides that default, so
 * it may carry only what changes (`enabled: false` turns it off); a team's own
 * rule needs a name and instructions. Stored configs are read with this
 * schema, so it stays lenient; a save also goes through
 * `riskCriteriaInputSchema`.
 */
export const riskCriterionSchema = z
    .object({
        id: z.string().trim().min(1).max(100),
        name: z.string().trim().min(1).max(120).optional(),
        enabled: z.boolean(),
        instructions: z.string().trim().min(1).max(4000).optional(),
        includedFiles: filePatternListSchema.optional(),
        excludedFiles: filePatternListSchema.optional(),
    })
    .refine(
        (criterion) =>
            criterion.id.startsWith(DEFAULT_RISK_CRITERION_PREFIX) ||
            (!!criterion.name && !!criterion.instructions),
        'A team risk rule needs a name and instructions.',
    );

export type RiskCriterion = z.infer<typeof riskCriterionSchema>;

export const riskCriteriaSchema = z
    .array(riskCriterionSchema)
    .max(50)
    .refine(
        (criteria) =>
            new Set(criteria.map((criterion) => criterion.id)).size ===
            criteria.length,
        'Risk criteria must have unique IDs.',
    );

/**
 * What a save may store: also refuses a `kodus-` id Kodus never shipped, which
 * the assessment would otherwise ignore without a word (a typo such as
 * `kodus-securty`). Reads stay on `riskCriteriaSchema`, so a config stored
 * before a rule was renamed never fails to load.
 */
export const riskCriteriaInputSchema = riskCriteriaSchema.superRefine(
    (criteria, ctx) =>
        criteria.forEach((criterion, index) => {
            if (
                criterion.id.startsWith(DEFAULT_RISK_CRITERION_PREFIX) &&
                !isKnownKodusRiskRuleId(criterion.id)
            )
                ctx.addIssue({
                    code: 'custom',
                    path: [index, 'id'],
                    message: `"${criterion.id}" is not a Kodus risk rule; ids starting with ${DEFAULT_RISK_CRITERION_PREFIX} are reserved for them.`,
                });
        }),
);

export const riskReviewRoutingSchema = z.object({
    noRisk: z.enum(['balanced', 'heavy', 'ultra']).optional(),
    riskFound: z.enum(['balanced', 'heavy', 'ultra']).optional(),
});

export type RiskReviewRouting = z.infer<typeof riskReviewRoutingSchema>;
