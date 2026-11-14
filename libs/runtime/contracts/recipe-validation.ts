import { z } from 'zod';

/** Explicit internal checks, never boot readiness or regression proof (ADR-053). */
export const RECIPE_VALIDATION_LIMITS = {
    checks: 32,
    name: 128,
    commandBytes: 8192,
} as const;
export const RecipeValidationNameSchema = z
    .string()
    .min(1)
    .max(RECIPE_VALIDATION_LIMITS.name)
    .refine(
        (v) =>
            v.trim() !== '' &&
            !/[\u0000-\u001f\u007f]/.test(v) &&
            new TextEncoder().encode(v).byteLength <=
                RECIPE_VALIDATION_LIMITS.name,
        'validate name must be nonblank, bounded and have no control characters',
    );
export const RecipeValidationCheckSchema = z.strictObject({
    name: RecipeValidationNameSchema,
    run: z
        .string()
        .min(1)
        .max(RECIPE_VALIDATION_LIMITS.commandBytes)
        .refine(
            (v) =>
                /[^ \t\r\n]/.test(v) &&
                !v.includes('\0') &&
                new TextEncoder().encode(v).byteLength <=
                    RECIPE_VALIDATION_LIMITS.commandBytes,
            'validate.run must be a nonblank bounded command without NUL',
        ),
});
export const RecipeValidationChecksSchema = z
    .array(RecipeValidationCheckSchema)
    .max(RECIPE_VALIDATION_LIMITS.checks)
    .superRefine((checks, ctx) => {
        const names = new Set<string>();
        for (const [i, check] of checks.entries()) {
            if (names.has(check.name))
                ctx.addIssue({
                    code: 'custom',
                    path: [i, 'name'],
                    message: 'validate names must be unique',
                });
            names.add(check.name);
        }
    });
export type RecipeValidationCheck = z.infer<typeof RecipeValidationCheckSchema>;
export const RecipeValidationSnapshotSchema = z.strictObject({
    recipeSha: z.string().regex(/^[0-9a-f]{40}$/),
    recipeDigest: z.string().regex(/^[0-9a-f]{64}$/),
    checks: RecipeValidationChecksSchema,
});
export type RecipeValidationSnapshot = z.infer<
    typeof RecipeValidationSnapshotSchema
>;
