import * as yaml from 'js-yaml';

import { parseRecipe, type Recipe, RECIPE_TEST_VALUES } from '@libs/runtime/protocol/recipe';
import { SECRET_NAME } from '@libs/runtime/run/recipe-inference';

/**
 * The rules a recipe Kody wrote must pass on top of every rule a recipe in the
 * repository passes (parseRecipe, then the cell's own checks). A recipe from
 * the repository is the team's code; one Kody wrote came from text the model
 * read, which a pull request or a README can steer. So it gets no field a
 * person did not need to write by hand, and its commands are plain calls of a
 * known tool. Reproduction exports recorded data, never commands for the developer's host.
 */

/** The only fields an authored recipe may set. */
const ALLOWED = {
    top: new Set(['version', 'services', 'data']),
    services: new Set(['compose', 'expose']),
    compose: new Set(['files', 'profiles', 'public', 'health', 'health_timeout', 'env']),
    data: new Set(['migrate', 'seed', 'reset']),
} as const;

/** The first word of a migrate or seed command; `npx` only with a migration tool it names. */
const COMMAND_TOOLS = new Set([
    'npm',
    'pnpm',
    'yarn',
    'bun',
    'node',
    'python',
    'python3',
    'uv',
    'poetry',
    'pipenv',
    'bundle',
    'rails',
    'rake',
    'php',
    'alembic',
    'flask',
    'django-admin',
    'mix',
    'dotnet',
    'make',
]);
const NPX_TOOLS = new Set(['prisma', 'knex', 'sequelize', 'sequelize-cli', 'typeorm', 'drizzle-kit', 'node-pg-migrate', 'db-migrate', 'medusa', 'payload']);
/** A word of a command: no shell syntax at all (no ; | & $ ` < > ( ) { } quotes, globs, ~ or #). */
const WORD = /^[A-Za-z0-9_@%+=:,./-]+$/;
const MAX_COMMAND = 200;
const HEALTH_PATH = /^\/[A-Za-z0-9._~/-]{0,200}$/;

export interface AuthoredRecipeCheck {
    ok: boolean;
    /** Each rule the recipe breaks, in words the model can act on. */
    errors: string[];
    recipe?: Recipe;
}

/** Why a command is refused, or null when it is a plain call of a known tool. */
export function commandProblem(command: string): string | null {
    const c = command.trim();
    if (!c) return 'is empty';
    if (c.length > MAX_COMMAND) return `is longer than ${MAX_COMMAND} characters`;
    if (/[\r\n]/.test(c)) return 'has more than one line';
    if (/:\/\//.test(c)) return 'has a URL; a recipe command never downloads anything';
    const words = c.split(/\s+/);
    const bad = words.find((w) => !WORD.test(w));
    if (bad !== undefined) return `has shell syntax (${JSON.stringify(bad.slice(0, 40))}); write one plain command, no pipes, quotes or variables`;
    const tool = words[0];
    if (tool === 'npx') {
        const pkg = (words[1] ?? '').replace(/@[^/]*$/, '');
        return NPX_TOOLS.has(pkg)
            ? null
            : `runs npx ${JSON.stringify(words[1] ?? '')}; npx is allowed only for a migration tool (${[...NPX_TOOLS].join(', ')})`;
    }
    if (!COMMAND_TOOLS.has(tool)) return `starts with ${JSON.stringify(tool)}; use the project's own tool (${[...COMMAND_TOOLS].join(', ')})`;
    return null;
}

const isMap = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function unknownKeys(errors: string[], where: string, value: unknown, allowed: Set<string>) {
    if (!isMap(value)) return;
    for (const k of Object.keys(value)) if (!allowed.has(k)) errors.push(`${where}${k}: Kody does not write this field; leave it out`);
}

/**
 * Checks the text Kody submitted. `exists` says whether a repository file is
 * there at the commit (the compose files and the seed SQL must be).
 */
/**
 * The public service as the merged compose files declare it (later files win,
 * as with docker compose -f a -f b), or undefined when no file names it.
 */
async function publicServiceOf(files: string[], name: string, read: (path: string) => Promise<string | null>): Promise<Record<string, unknown> | undefined> {
    let merged: Record<string, unknown> | undefined;
    for (const f of files) {
        const text = await read(f);
        if (text === null) continue;
        let doc: unknown;
        try {
            // The default schema: compose files merge anchors with `<<`, which the core schema leaves unmerged.
            doc = yaml.load(text);
        } catch {
            continue;
        }
        const svc = isMap(doc) && isMap(doc.services) ? doc.services[name] : undefined;
        if (isMap(svc)) merged = { ...(merged ?? {}), ...svc };
    }
    return merged;
}

export async function checkAuthoredRecipe(
    text: string,
    exists: (path: string) => Promise<boolean>,
    read?: (path: string) => Promise<string | null>,
): Promise<AuthoredRecipeCheck> {
    const errors: string[] = [];
    const parsed = parseRecipe(text);
    if ('error' in parsed) {
        // Authoring never gains resource or network authority, even when a forbidden value is malformed.
        try { unknownKeys(errors, '', yaml.load(text, { schema: yaml.CORE_SCHEMA }), ALLOWED.top); } catch { /* The recipe parser already reported malformed YAML. */ }
        return { ok: false, errors: errors.length ? errors : [parsed.error] };
    }
    const recipe = parsed.recipe;

    const doc = yaml.load(text, { schema: yaml.CORE_SCHEMA }) as Record<string, unknown>;
    unknownKeys(errors, '', doc, ALLOWED.top);
    unknownKeys(errors, 'services.', doc.services, ALLOWED.services);
    unknownKeys(errors, 'services.compose.', isMap(doc.services) ? doc.services.compose : undefined, ALLOWED.compose);
    unknownKeys(errors, 'data.', doc.data, ALLOWED.data);

    if (recipe.composeFiles.length === 0) {
        // No compose file: the cell builds the root Dockerfile as one service it names `app`.
        if (!(await exists('Dockerfile')))
            errors.push('services.compose.files: name the compose file(s) of the repository to boot; there is no root Dockerfile to build instead');
        else if (recipe.public.length !== 1 || recipe.public[0] !== 'app')
            errors.push('services.compose.public: a recipe without compose files boots the root Dockerfile as the one service `app`; set public: app');
    }
    for (const f of recipe.composeFiles) if (!(await exists(f))) errors.push(`services.compose.files: ${f} is not in the repository at this commit`);
    if (recipe.public.length === 0) errors.push('services.compose.public: name the service that answers the health check');
    // A public service that only pulls a published image boots without the commit's code: every Run would test the
    // release, not the pull request, and say "no regressions". It must be built from the repository.
    if (read && recipe.composeFiles.length > 0 && recipe.public[0]) {
        const svc = await publicServiceOf(recipe.composeFiles, recipe.public[0], read);
        // `extends` takes the build from another file or service: not something to read here, so no refusal.
        if (svc && svc.image && !svc.build && !svc.extends) {
            errors.push(
                `services.compose.public: ${recipe.public[0]} runs the published image ${JSON.stringify(String(svc.image ?? '?'))}, so the pull request's code never runs; use the compose file (or profile) that builds it from the repository`,
            );
        }
    }
    if (recipe.health !== undefined && !HEALTH_PATH.test(recipe.health))
        errors.push(`services.compose.health: ${JSON.stringify(recipe.health)} is not a plain path like /health`);
    if (!recipe.expose.some((e) => e.kind === 'http' && recipe.public.includes(e.service))) {
        errors.push('services.expose: the public service needs an http entry, with the port it listens on inside its container');
    }

    for (const [name, value] of Object.entries(recipe.env)) {
        if (SECRET_NAME.test(name) && !(RECIPE_TEST_VALUES as readonly string[]).includes(value)) {
            errors.push(
                `services.compose.env.${name}: looks like a secret; a recipe never holds one (use ${RECIPE_TEST_VALUES[0]} if the app only needs it set)`,
            );
        }
        if (/:\/\/[^/\s]*@/.test(value)) errors.push(`services.compose.env.${name}: a URL with credentials in it`);
    }

    if (recipe.migrate !== undefined) {
        const p = commandProblem(recipe.migrate);
        if (p) errors.push(`data.migrate ${p}`);
    }
    const seed = recipe.seed;
    if (seed) {
        if (!seed.service) {
            errors.push('data.seed: Kody writes a seed as { service, sql } or { service, command }, never a host command');
        } else if (seed.sql) {
            if (!(await exists(seed.sql))) errors.push(`data.seed.sql: ${seed.sql} is not in the repository at this commit`);
        } else if (seed.command) {
            const p = commandProblem(seed.command);
            if (p) errors.push(`data.seed.command ${p}`);
        }
    }

    return errors.length ? { ok: false, errors } : { ok: true, errors: [], recipe };
}
