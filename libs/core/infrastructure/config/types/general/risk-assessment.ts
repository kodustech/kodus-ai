import { z } from 'zod';
import { filePatternListSchema } from './file-pattern-schema';

/** Team guidance supplements Kody's assessment; file filters scope guidance. */
export const riskCriterionSchema = z.object({
    id: z.string().trim().min(1).max(100),
    name: z.string().trim().min(1).max(120),
    enabled: z.boolean(),
    instructions: z.string().trim().min(1).max(4000),
    includedFiles: filePatternListSchema.optional(),
    excludedFiles: filePatternListSchema.optional(),
});

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

export const riskReviewRoutingSchema = z.object({
    noRisk: z.enum(['balanced', 'heavy']).optional(),
    riskFound: z.enum(['balanced', 'heavy']).optional(),
});

export type RiskReviewRouting = z.infer<typeof riskReviewRoutingSchema>;
