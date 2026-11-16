// The version of the instructions Kody's recipe author writes with
// (libs/runtime/api/application/recipe-author/recipe-author.agent.ts). Each
// authored recipe records the version that wrote it. A recipe that booted is
// kept as long as its checks pass, so a change of the instructions never
// reached the environments that already had one (kr-nextjs kept `next dev`
// after 41350054e told the author to start the production server).
//
// The owners of the author bump the version here, by hand, in the same change
// as the instructions: `reauthor: true` only for a change existing recipes
// must get (a recipe written before it is wrong by the new rules), false for
// one that only helps new recipes. The next setup of an environment whose
// recipe predates a `reauthor` revision asks Kody once to write it again under
// it; the old recipe stays when the new one does not pass its checks.

/** The recipe a revision is asked about: Kody's text, notes and own files. */
export interface RevisedRecipe {
    recipe: string;
    notes?: string;
    files?: ReadonlyArray<{ content: string }>;
}

export interface RecipeAuthorRevision {
    version: number;
    /** Recipes written before it are written again, once per environment. */
    reauthor: boolean;
    /** One line the environment's screen shows: what changed for recipes. */
    reason: string;
    /** Only the recipes this is true of are written again for it; absent: every recipe. */
    appliesTo?: (recipe: RevisedRecipe) => boolean;
}

/** A recipe that names next/font/google in its text, its notes or its files (Kody says so in notes, by the rule). */
const namesGoogleFonts = (r: RevisedRecipe) => [r.recipe, r.notes ?? '', ...(r.files ?? []).map((f) => f.content)].some((t) => t.includes('next/font/google'));

export const RECIPE_AUTHOR_REVISIONS: readonly RecipeAuthorRevision[] = [
    { version: 1, reauthor: false, reason: 'the instructions before recipes recorded their version' },
    { version: 2, reauthor: true, reason: 'an app with pages starts on its production server (next start, not next dev)' },
    {
        version: 3,
        reauthor: true,
        reason: 'Google Fonts is on the recommended egress list: a Next.js app that imports next/font/google builds for production',
        appliesTo: namesGoogleFonts,
    },
];

/** The version the author writes with now. */
export const RECIPE_AUTHOR_VERSION = RECIPE_AUTHOR_REVISIONS.reduce((v, r) => Math.max(v, r.version), 1);

/** A recipe that recorded no version was written before versions existed. */
export const UNVERSIONED_RECIPE_AUTHOR_VERSION = 1;

/**
 * The revision a recipe written at `writtenAt` must be written again for:
 * the newest `reauthor` revision past it that this environment has not tried
 * yet (`triedUpTo`, the last version a re-authoring was attempted for) and
 * that applies to `recipe` (a revision's `appliesTo`). Undefined: the recipe
 * stands.
 */
export function reauthorRevision(writtenAt: number | undefined, triedUpTo: number | undefined, recipe?: RevisedRecipe): RecipeAuthorRevision | undefined {
    const from = writtenAt ?? UNVERSIONED_RECIPE_AUTHOR_VERSION;
    const tried = triedUpTo ?? 0;
    return [...RECIPE_AUTHOR_REVISIONS]
        .filter((r) => r.reauthor && r.version > from && r.version > tried && r.version <= RECIPE_AUTHOR_VERSION)
        .filter((r) => !r.appliesTo || !recipe || r.appliesTo(recipe))
        .sort((a, b) => b.version - a.version)[0];
}

/** The revision of a version, for its reason. */
export const recipeAuthorRevision = (version: number): RecipeAuthorRevision | undefined => RECIPE_AUTHOR_REVISIONS.find((r) => r.version === version);
