import { z } from 'zod';
import { filePatternListSchema } from './file-pattern-schema';
import {
    DEFAULT_RISK_CRITERION_PREFIX,
    MAX_RISK_CRITERIA,
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
    .max(MAX_RISK_CRITERIA)
    .refine(
        (criteria) =>
            new Set(criteria.map((criterion) => criterion.id)).size ===
            criteria.length,
        'Risk criteria must have unique IDs.',
    );

/**
 * What a save or a kodus-config.yml may hold: an entry that matches no Kodus
 * rule needs a name and instructions, so a mistyped override such as
 * `{ id: 'kodus-securty', enabled: false }` is refused instead of being
 * ignored by the assessment without a word. It refuses exactly what
 * `effectiveRiskCriteria` drops. Stored configs are read with
 * `riskCriteriaSchema`, so they never fail to load.
 */
export const riskCriteriaInputSchema = riskCriteriaSchema.superRefine(
    (criteria, ctx) =>
        criteria.forEach((criterion, index) => {
            if (
                !isKnownKodusRiskRuleId(criterion.id) &&
                (!criterion.name || !criterion.instructions)
            )
                ctx.addIssue({
                    code: 'custom',
                    path: [index, 'id'],
                    message: `"${criterion.id}" matches no Kodus risk rule; check the id, or give the rule a name and instructions.`,
                });
        }),
);

export const riskReviewRoutingSchema = z.object({
    noRisk: z.enum(['balanced', 'heavy', 'ultra']).optional(),
    riskFound: z.enum(['balanced', 'heavy', 'ultra']).optional(),
});

export type RiskReviewRouting = z.infer<typeof riskReviewRoutingSchema>;
