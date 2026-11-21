import { z } from 'zod';

import { AuthoredFilesSchema } from './authored-files';
import { RUNTIME_RECIPE_MAX_BYTES } from './runtime-commands';
import { SETUP_AUTHOR_REPAIRS_MAX } from '@libs/runtime/run/environment-setup';

// POST /internal/runtime/recipe-author (docs RECIPE-AGENT-TEST-PLAN, "Ligar ao
// produto"): the setup's recipe step asks the product to have Kody write the
// recipe of a repository that has none and whose files Kodus could not infer
// one from. The agent runs in the API with the org's BYOK (ADR-057); the
// worker only holds the setup token. Shared here so both sides parse the same
// bodies.

export const RECIPE_AUTHOR_PATH = 'internal/runtime/recipe-author';

/** How the last setup's boot of `last` failed, as the worker's catalog classified it (already redacted by the cell). */
export const RecipeAuthorFailureSchema = z.strictObject({
    signature: z.string().min(1).max(256),
    title: z.string().min(1).max(500),
    evidence: z.array(z.string().max(500)).max(20),
});

/**
 * The recipe Kody wrote that the environment's last setup booted with, at
 * another commit. Without `failure` it booted and answered: the product checks
 * it again at this commit and, when it passes, answers it as is, with no model
 * call (`reused`). Otherwise (the checks refuse it now, or `failure` says how
 * its boot failed) Kody writes a new one from it and that failure.
 */
export const RecipeAuthorLastSchema = z.strictObject({
    recipe: z.string().min(1).max(RUNTIME_RECIPE_MAX_BYTES),
    files: AuthoredFilesSchema.optional(),
    notes: z.string().max(1_000).optional(),
    failure: RecipeAuthorFailureSchema.optional(),
});
export type RecipeAuthorLast = z.infer<typeof RecipeAuthorLastSchema>;

/** The setup's first authoring: what a request without `attempt` (a worker that predates it) is. */
export const RECIPE_AUTHOR_FIRST_ATTEMPT = 'author-0';

/**
 * Which authoring of the setup this is: `author-0` its first, `repair-<n>`
 * the rewrite after boot n of Kody's recipe failed (n up to
 * SETUP_AUTHOR_REPAIRS_MAX). The product answers each (setupKey, attempt)
 * once: asked again it returns the same answer with no new run and no new
 * budget, and while it is still being written it answers 409
 * { code: 'author_in_progress' } (ask again later). The same attempt asked
 * with another body is 409 { code: 'attempt_conflict' }.
 */
export const RecipeAuthorAttemptSchema = z
    .string()
    .regex(/^(author-0|repair-[1-9]\d?)$/)
    .refine((a) => a === RECIPE_AUTHOR_FIRST_ATTEMPT || Number(a.slice('repair-'.length)) <= SETUP_AUTHOR_REPAIRS_MAX, 'attempt out of range');

/** The `code` of the 409s of an attempt asked again. */
export const RECIPE_AUTHOR_REFUSAL = { inProgress: 'author_in_progress', conflict: 'attempt_conflict' } as const;

/**
 * `last` booted, but was written under an older version of the author's
 * instructions than a revision that asks existing recipes to be written again
 * (libs/runtime/run/recipe-author-version.ts): the product does not answer it
 * as is, Kody writes it again under the current instructions, from it.
 */
export const RecipeAuthorReauthorSchema = z.strictObject({
    from: z.number().int().min(1).max(10_000),
    to: z.number().int().min(1).max(10_000),
});

/** The commit the setup boots; the product checks it is the one it recorded for this setup. */
export const RecipeAuthorRequestSchema = z.strictObject({
    sha: z.string().regex(/^[0-9a-f]{40}$/),
    last: RecipeAuthorLastSchema.optional(),
    /** Absent: `author-0`, answered as before (see RecipeAuthorAttemptSchema). */
    attempt: RecipeAuthorAttemptSchema.optional(),
    /** Only with a `last` that booted (no failure). */
    reauthor: RecipeAuthorReauthorSchema.optional(),
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
        /** The request's `last`, passed by the checks at this commit and answered as is: no model call. */
        reused: z.literal(true).optional(),
        /** What Kodus rewrote in Kody's compose files before the checks passed them (dropped container_name, inlined extends, missing env_file). */
        adjusted: z.array(z.string().max(300)).max(20).optional(),
        /** The version of the author's instructions Kody wrote it with (RECIPE_AUTHOR_VERSION); absent on a reused one, and from an older product. */
        authorVersion: z.number().int().min(1).max(10_000).optional(),
        usage: Usage,
    }),
    z.object({
        status: z.literal('no_recipe'),
        reason: z.string().min(1).max(500),
        usage: Usage,
    }),
]);
export type RecipeAuthorResponse = z.infer<typeof RecipeAuthorResponseSchema>;
