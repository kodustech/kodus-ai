import { createHash } from 'crypto';

import type { AuthoredFile } from '@libs/runtime/contracts/authored-files';
import { type Expose, ExposeSchema } from '@libs/runtime/contracts/enums';
import type { RecipeFake } from '@libs/runtime/protocol/recipe-fakes';
import { parseRecipe, type RecipeSize } from '@libs/runtime/protocol/recipe';

// The part of `.kodus/workspace.yaml` (docs §6) the control plane needs: what
// the environment exposes and where its ready check is. The recipe itself,
// and every rule the cell enforces, is defined once in the runtime protocol
// (libs/runtime/protocol/recipe.ts); this only keeps the summary, so a recipe
// the worker records is one the cell accepts up to its driver policy.

export type RecipeExpose = Expose;

export interface RecipeSummary {
    version: 1;
    expose: RecipeExpose[];
    /** The primary of services.compose.public: the service the ready check calls. */
    public?: string;
    /** services.compose.health: the ready path on the public service. */
    health?: string;
    /** services.compose.health_timeout: how long the ready check waits for the app to answer, in seconds. */
    healthTimeoutSeconds?: number;
    /** The keys the recipe sets that no cell acts on yet (validate, fakes, flags, ...): the setup says so. */
    unapplied?: string[];
    size?: RecipeSize;
    egressAllow?: string[];
    fakes?: RecipeFake[];
}

export type RecipeParse = { ok: true; recipe: RecipeSummary } | { ok: false; error: string };

/**
 * What a Run records to say which recipe it booted with: sha256 of the recipe
 * text, or, with the files Kody wrote next to it, of the recipe and every
 * file (path and content, in path order), so a change to any of them is
 * another digest. Without files it is the digest it always was.
 */
export function recipeDigest(text: string, files?: readonly AuthoredFile[]): string {
    if (!files?.length) return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
    const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)).map((f) => [f.path, f.content]);
    const bundle = JSON.stringify({ recipe: text, files: sorted });
    return `sha256:${createHash('sha256').update(`kody-runtime/recipe+files\0${bundle}`, 'utf8').digest('hex')}`;
}

export function parseRecipeSummary(text: string): RecipeParse {
    const parsed = parseRecipe(text);
    if ('error' in parsed) return { ok: false, error: parsed.error };
    const r = parsed.recipe;
    const expose = r.expose.map((e) => ExposeSchema.safeParse(e));
    const bad = expose.findIndex((e) => !e.success);
    if (bad >= 0) return { ok: false, error: `recipe: services.expose[${bad}] needs service, a port 1-65535 and kind http, postgres, mysql or grpc` };
    return {
        ok: true,
        recipe: {
            version: 1,
            expose: expose.map((e) => e.data as RecipeExpose),
            ...(r.public[0] ? { public: r.public[0] } : {}),
            ...(r.health ? { health: r.health } : {}),
            ...(r.healthTimeoutSeconds !== undefined ? { healthTimeoutSeconds: r.healthTimeoutSeconds } : {}),
            ...(r.unapplied?.length ? { unapplied: r.unapplied } : {}),
            ...(r.size ? { size: r.size } : {}),
            ...(r.egressAllow ? { egressAllow: r.egressAllow } : {}),
            ...(r.fakes ? { fakes: r.fakes } : {}),
        },
    };
}
