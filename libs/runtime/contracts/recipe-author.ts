import { z } from 'zod';

import { AuthoredFilesSchema } from './authored-files';
import { RUNTIME_RECIPE_MAX_BYTES } from './runtime-commands';

// POST /internal/runtime/recipe-author (docs RECIPE-AGENT-TEST-PLAN, "Ligar ao
// produto"): the setup's recipe step asks the product to have Kody write the
// recipe of a repository that has none and whose files Kodus could not infer
// one from. The agent runs in the API with the org's BYOK (ADR-057); the
// worker only holds the setup token. Shared here so both sides parse the same
// bodies.

export const RECIPE_AUTHOR_PATH = 'internal/runtime/recipe-author';

/** The commit the setup boots; the product checks it is the one it recorded for this setup. */
export const RecipeAuthorRequestSchema = z.strictObject({
    sha: z.string().regex(/^[0-9a-f]{40}$/),
});
export type RecipeAuthorRequest = z.infer<typeof RecipeAuthorRequestSchema>;

const Usage = z.object({ inputTokens: z.number().int().min(0), outputTokens: z.number().int().min(0) });

export const RecipeAuthorResponseSchema = z.discriminatedUnion('status', [
    z.object({
        status: z.literal('submitted'),
        recipe: z.string().min(1).max(RUNTIME_RECIPE_MAX_BYTES),
        notes: z.string().max(1_000).optional(),
        /** The Dockerfiles and compose files under .kodus/ the recipe needs, checked with it at the same commit; absent: it needs none. */
        files: AuthoredFilesSchema.optional(),
        usage: Usage,
    }),
    z.object({
        status: z.literal('no_recipe'),
        reason: z.string().min(1).max(500),
        usage: Usage,
    }),
]);
export type RecipeAuthorResponse = z.infer<typeof RecipeAuthorResponseSchema>;
