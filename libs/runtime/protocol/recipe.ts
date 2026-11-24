import { posix } from 'path';

import * as yaml from 'js-yaml';
import { z } from 'zod';

import { RecipeValidationChecksSchema, type RecipeValidationCheck } from '@libs/runtime/contracts/recipe-validation';

import { EXPOSE_KINDS } from '@libs/runtime/contracts/enums';
import { MAX_RECIPE_NEEDS, MAX_REPOSITORY_FULL_NAME, REPOSITORY_ALIAS_PATTERN, REPOSITORY_FULL_NAME_PATTERN, repositoryAliasOf } from '@libs/runtime/contracts/workspace';
import { RecipeFakesSchema, normalizeRecipeFakes, rawFakeInputError, type RecipeFake } from './recipe-fakes';
import {
    MACHINE_SIZES,
    MACHINE_SIZE_LIMITS,
} from '@libs/runtime/contracts/machine-size';
import CONTROL_ENV from './recipe-control-env.json';
import { UNTRUSTED_YAML } from './yaml-limits';

// `.kodus/workspace.yaml` (docs §6): the recipe Runo reads on a developer's
// machine and the cell boots from. This is its one TS definition. The cell
// enforces the same rules in Go (apps/runtime-cell/internal/recipe), and the
// fixtures in fixtures/recipes hold both, and Runo's parser, to the same
// verdicts (ENV-08). The JSON Schema in recipe.schema.json is generated from
// RecipeSchema (scripts/dump-recipe-schema.ts) for editors and for the agent
// that writes recipes; the rules a schema cannot say (secrets, paths) are in
// recipeRules.

export const RECIPE_PATH = '.kodus/workspace.yaml';

export const RECIPE_LIMITS = { composeFiles: 8, profiles: 16, public: 16, exposed: 32, healthLength: 512 } as const;

/**
 * The most a setup waits for the app (services.compose.health_timeout), in
 * seconds; the cell's recipe.MaxHealthTimeout is the same. A longer wait is
 * read as this one, not refused: a Runo recipe may wait longer on a
 * developer's VM (Kodus's own says 20m), and boots in a cell all the same.
 * The not_ready card never proposes more (blockers/catalog.ts).
 */
export const MAX_HEALTH_TIMEOUT_SECONDS = 900;

/** The two values a Kodus fix writes (blockers/catalog.ts testValueFor): allowed under a name that looks like a secret. */
export const RECIPE_TEST_VALUES = ['kodus-test-value', 'http://kodus-fake.invalid'] as const;

const scalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const names = z.union([z.string(), z.array(z.string())]);
/** A bare number is seconds, as in Runo; otherwise a Go duration (120s, 10m, 1h30m). */
const duration = z.union([z.number(), z.string()]);
const port = z.number().int();

export const RecipeComposeSchema = z.strictObject({
    files: z.array(z.string()).optional().describe('Compose files, merged in order like docker compose -f a -f b.'),
    file: z.string().optional().describe("Runo's one-file form of files."),
    profiles: z.array(z.string()).optional().describe('Compose profiles whose services start beside the ones with no profile.'),
    public: names.optional().describe('The service whose health path says the app is up; a list puts the primary first.'),
    public_port: port.optional().describe("Runo's: which published port of the primary its VM serves. One public service only."),
    health: z.string().optional().describe('HTTP path asked on the public service, over its http entry in services.expose.'),
    health_timeout: duration.optional().describe('How long the boot waits for health: seconds, or 120s, 10m. Unset or 0 waits 2 minutes; more than 15 minutes waits 15.'),
    env: z.record(z.string(), scalar).optional().describe('Variables every service gets, over the compose file. Never secrets.'),
});

/** One other repository the recipe boots beside its own (services.needs). */
export const RecipeNeedSchema = z.strictObject({
    repo: z.string().describe('The repository, as owner/name (or group/subgroup/name) on the same Git provider.'),
    alias: z.string().optional().describe("Its directory beside this one (../<alias> in a compose file): lower case letters, digits, '.', '_' and '-'. Default: the repository's short name."),
});

export const RecipeExposedPortSchema = z.strictObject({
    service: z.string(),
    port,
    kind: z.enum(EXPOSE_KINDS),
    readonly_user_from_seed: z.boolean().optional(),
});

const seedMapping = z.strictObject({
    service: scalar,
    command: scalar.optional(),
    sql: scalar.optional(),
    user: scalar.optional(),
    database: scalar.optional(),
});

/** Neutral resource requirements; runtime policy, not the recipe, authorizes them. */
export interface RecipeSize {
    cpus?: number;
    memoryMb?: number;
    diskGb?: number;
}
const resourceFields = {
    cpu: z.number().int().min(1).max(MACHINE_SIZE_LIMITS.cpus.max).optional(),
    memory: z.string().max(32).optional(),
    disk: z.string().max(32).optional(),
};
const sizeObject = z.strictObject(resourceFields);
const recipeSize = z.union([sizeObject, z.enum(['small', 'medium', 'large'])]);
const legacyLimits = z.strictObject({
    ...resourceFields,
    instance: z.string().max(128).optional(),
    idle_suspend: duration.optional(),
    idle_activity: z.array(z.string().max(64)).max(16).optional(),
});
const recipeEgress = z.strictObject({
    allow: z.array(z.string().max(253)).max(256),
});

/** Exact public DNS syntax only; actual authorization is the cell's default+admin policy. */
function recipeHost(raw: string): string | undefined {
    const host = raw.trim().toLowerCase().replace(/\.$/, '');
    const labels = host.split('.');
    if (
        labels.length < 2 ||
        host.length > 253 ||
        !labels.every((l) =>
            /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(l),
        ) ||
        !/[a-z]/.test(labels.at(-1)!)
    )
        return undefined;
    return host;
}
function recipeBytes(
    raw: string | undefined,
    kind: 'memory' | 'disk',
): number | undefined {
    if (raw === undefined) return undefined;
    const m = /^([1-9][0-9]{0,8})(mb|mib|gb|gib)$/i.exec(raw);
    if (!m) return undefined;
    const mb = Number(m[1]) * (/^g/i.test(m[2]) ? 1024 : 1);
    if (kind === 'memory')
        return mb >= MACHINE_SIZE_LIMITS.memoryMb.min &&
            mb <= MACHINE_SIZE_LIMITS.memoryMb.max
            ? mb
            : undefined;
    return mb % 1024 === 0 && mb >= 1024 && mb <= 16_384 * 1024
        ? mb / 1024
        : undefined;
}
function resolvedSize(d: {
    size?: z.infer<typeof recipeSize>;
    limits?: z.infer<typeof legacyLimits>;
}): RecipeSize | string | undefined {
    const legacy = d.limits;
    const hasLegacy =
        legacy !== undefined &&
        [legacy.cpu, legacy.memory, legacy.disk].some((v) => v !== undefined);
    if (d.size !== undefined && hasLegacy)
        return 'size and limits resource fields together; use one';
    const raw = d.size ?? (hasLegacy ? legacy : undefined);
    if (raw === undefined) return undefined;
    if (typeof raw === 'string') return { ...MACHINE_SIZES[raw] };
    if ((raw.cpu === undefined) !== (raw.memory === undefined))
        return 'size: cpu and memory must be declared together';
    const memoryMb = recipeBytes(raw.memory, 'memory'),
        diskGb = recipeBytes(raw.disk, 'disk');
    if (raw.memory !== undefined && memoryMb === undefined)
        return 'size.memory: use 512mb to 256gb';
    if (raw.disk !== undefined && diskGb === undefined)
        return 'size.disk: use whole GB from 1gb to 16384gb';
    if (raw.cpu === undefined && raw.disk === undefined)
        return 'size: declare cpu and memory, or disk';
    return {
        ...(raw.cpu !== undefined ? { cpus: raw.cpu, memoryMb } : {}),
        ...(diskGb !== undefined ? { diskGb } : {}),
    };
}

/** The suite block (docs/runtime/e2e-suites.md section 3): the repository's own e2e suite, run by the worker. */
export const SUITE_RUNNERS = ['cypress', 'playwright'] as const;
export const SUITE_LIMITS = { commandBytes: 1024, env: 16, artifacts: 8, ignore: 32, shards: 16, maxTimeoutSeconds: 7200 } as const;
/** Where a runner writes its result files when the recipe names no `results.junit`. */
export const DEFAULT_SUITE_RESULTS_GLOB = 'results/*.xml';
const RecipeSuiteSchema = z.strictObject({
    runner: z.enum(SUITE_RUNNERS).describe('The runner the repository uses for its e2e tests.'),
    command: z.string().describe('The command a shard runs; {specs} is the comma list of spec files the engine fills. Never --record or --parallel: those need Cypress Cloud.'),
    cwd: z.string().max(512).optional().describe('Where the command runs, relative to the repository root.'),
    specs: z.string().max(512).describe('Glob of the spec files, relative to cwd.'),
    shards: z.number().int().min(1).max(SUITE_LIMITS.shards).optional().describe('A ceiling on the hosts the suite is spread over.'),
    service: z.string().max(128).optional().describe('The compose service of the environment the command runs in (its container has the repository, node and the browser).'),
    image: z.string().max(256).optional().describe('Not supported yet: refused. Add the image as a service of the compose file and name it with service.'),
    timeout: z.strictObject({ shard: duration.optional(), spec: duration.optional(), total: duration.optional() }).optional(),
    env: z.record(z.string(), scalar).optional().describe('Plain values only; secrets stay in the environment sealed secrets.'),
    results: z
        .strictObject({ junit: z.string().max(512).optional(), artifacts: z.array(z.string().max(512)).optional() })
        .optional()
        .describe('Where the runner writes its JUnit files, and the artifact paths to keep for failed specs.'),
    baseline: z.boolean().optional().describe('False: no run on main (a repository whose suite only runs in CI mode).'),
    ignore: z.array(z.string().max(512)).max(SUITE_LIMITS.ignore).optional().describe('Globs of files that never select specs (docs, assets).'),
    retries: z.strictObject({ main: z.number().int().min(1).max(2).optional() }).optional(),
    gate: z.enum(['default', 'strict']).optional().describe('strict: any unclassified failure fails the check.'),
});

export const RecipeSchema = z.strictObject({
    version: z.literal(1),
    setup: z.array(z.string()).optional(),
    services: z
        .strictObject({
            compose: RecipeComposeSchema.optional(),
            expose: z.array(RecipeExposedPortSchema).optional().describe('The ports the probes reach, by service.'),
            needs: z
                .array(RecipeNeedSchema)
                .max(MAX_RECIPE_NEEDS, { error: `at most ${MAX_RECIPE_NEEDS} repositories` })
                .optional()
                .describe('Other repositories booted beside this one, each in its own directory next to it.'),
        })
        .optional(),
    data: z
        .strictObject({
            migrate: z.string().optional(),
            seed: z.union([z.string(), seedMapping]).optional().describe('A host command, or a command or SQL file run in a service.'),
            reset: z.enum(['recreate', 'reseed', 'snapshot']).optional(),
        })
        .optional(),
    files: z
        .strictObject({ copy: z.array(z.string()).optional() })
        .optional()
        .describe('Runo only: a cell refuses files.copy.'),
    validate: RecipeValidationChecksSchema.optional(),
    limits: legacyLimits
        .optional().describe(
            'Version 1 alias for size; legacy instance and idle settings remain unapplied.',
        ),
    size: recipeSize.optional(),
    fakes: RecipeFakesSchema.optional(),
    flags: z.unknown().optional(),
    llm: z.unknown().optional(),
    egress: recipeEgress.optional(),
    ui: z.unknown().optional(),
    suite: RecipeSuiteSchema.optional(),
    expose: z.unknown().optional().describe("Runo's: how its VM is reached from outside; a cell ignores it."),
});
export type RecipeDoc = z.infer<typeof RecipeSchema>;

/** The recipe with Runo's short forms resolved: what the rules and the summary read. */
export interface Recipe {
    version: 1;
    validate?: RecipeValidationCheck[];
    composeFiles: string[];
    profiles: string[];
    public: string[];
    publicPort?: number;
    health?: string;
    healthTimeoutSeconds?: number;
    env: Record<string, string>;
    expose: { service: string; port: number; kind: (typeof EXPOSE_KINDS)[number] }[];
    migrate?: string;
    seed?: { command?: string; service?: string; sql?: string; user?: string; database?: string };
    filesCopy: string[];
    size?: RecipeSize;
    egressAllow?: string[];
    fakes?: RecipeFake[];
    /** The e2e suite the worker runs (the cell ignores it); absent when the recipe declares none. */
    suite?: RecipeSuite;
    /** A cell capability requirement only; the public Expose shape stays unchanged. */
    seededSQL?: true;
    /** services.needs with every alias resolved; absent when the recipe needs no other repository. */
    needs?: RecipeNeed[];
    /**
     * The keys the recipe sets that no cell acts on yet (recipe.Unapplied in
     * the cell, held to the same list by the recipe contract): the cell boots
     * as if they were absent, so the setup says so. Absent when there is none.
     */
    unapplied?: string[];
}

/** The suite block resolved: durations in seconds, defaults filled. */
export interface RecipeSuite {
    runner: (typeof SUITE_RUNNERS)[number];
    command: string;
    cwd?: string;
    specs: string;
    shards?: number;
    service?: string;
    image?: string;
    timeoutSeconds?: { shard?: number; spec?: number; total?: number };
    env: Record<string, string>;
    results?: { junit?: string; artifacts: string[] };
    baseline: boolean;
    ignore: string[];
    retriesMain?: number;
    gate: 'default' | 'strict';
}

/** One other repository a recipe boots beside its own, its alias resolved. */
export interface RecipeNeed {
    repo: string;
    alias: string;
}

/**
 * The keys no cell acts on yet. Not here: services.needs, which a cell
 * applies (the multi-repo workspace, docs/runtime/multi-repo.md), and expose,
 * which describes a Runo VM. Legacy non-sizing limits are named individually.
 */
export const RECIPE_UNAPPLIED_KEYS = ['flags', 'llm', 'ui'] as const;

export type RecipeParseResult = { ok: true; recipe: Recipe } | { ok: false; error: string };

const isMap = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown) => (v === null || v === undefined ? '' : String(v));

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const HEALTH_PATH = /^\/[A-Za-z0-9._~/?=&%-]*$/;
const SECRET_NAME = /(SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY|CREDENTIAL)/i;
const SECRET_VALUE = /(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_|sk-[A-Za-z0-9_-]{16,}|sk_live_|AKIA[0-9A-Z]{16}|xox[abpr]-|-----BEGIN)/;
// time.ParseDuration's grammar without the minus a positive duration never has.
const GO_DURATION = /^\+?(\d+(\.\d*)?|\.\d+)(ns|us|µs|ms|s|m|h)((\d+(\.\d*)?|\.\d+)(ns|us|µs|ms|s|m|h))*$/;
/** The longest time.Duration, in seconds: past it the cell's parser refuses the value, so the worker does too. */
// The largest Go duration, 9223372036.854775807 s, as the nearest double.
const MAX_GO_DURATION_SECONDS = 9_223_372_036.854_776;
const DURATION_UNIT: Record<string, number> = { ns: 1e-9, us: 1e-6, µs: 1e-6, ms: 1e-3, s: 1, m: 60, h: 3600 };

// What changes what runs rather than how the app is configured. recipe-control-env.json
// is the one source; apps/runtime-cell/internal/recipe/recipe-control-env.json is its byte copy.
const CONTROL_ENV_PREFIXES: readonly string[] = CONTROL_ENV.prefixes;
const CONTROL_ENV_NAMES: ReadonlySet<string> = new Set(CONTROL_ENV.names);
const isControlEnv = (name: string) => {
    const n = name.toUpperCase();
    return CONTROL_ENV_NAMES.has(n) || CONTROL_ENV_PREFIXES.some((p) => n.startsWith(p));
};

/** filepath.IsLocal on a Unix cell: relative and never above the repo. */
const insideRepo = (p: string) => {
    if (!p || p.startsWith('/')) return false;
    const n = posix.normalize(p);
    return n !== '..' && !n.startsWith('../');
};

/**
 * Seconds, or undefined when the value is no duration the cell takes
 * (recipe.Duration): a bare integer is seconds, as in Runo; anything else is
 * a Go duration. Zero is a wait the recipe does not set (recipes written
 * before durations were checked say health_timeout: 0 for "the default", and
 * must still boot after a deploy); a negative one is a typo the cell refuses
 * too.
 */
export function recipeDurationSeconds(v: unknown): number | undefined {
    let seconds: number;
    if (typeof v === 'number') {
        if (!Number.isInteger(v)) return undefined;
        seconds = v;
    } else if (typeof v === 'string' && /^[+-]?\d+$/.test(v)) {
        seconds = Number(v);
    } else if (typeof v === 'string' && GO_DURATION.test(v)) {
        seconds = 0;
        for (const m of v.matchAll(/(\d+(?:\.\d*)?|\.\d+)(ns|us|µs|ms|s|m|h)/g)) seconds += Number(m[1]) * DURATION_UNIT[m[2]];
    } else {
        return undefined;
    }
    return seconds >= 0 && seconds <= MAX_GO_DURATION_SECONDS ? seconds : undefined;
}

function zodError(issue: z.core.$ZodIssue): string {
    const at = issue.path
        .map((p) => (typeof p === 'number' ? `[${p}]` : `.${String(p)}`))
        .join('')
        .replace(/^\./, '');
    if (issue.code === 'unrecognized_keys') return `${at ? `${at}: ` : ''}unknown field ${JSON.stringify(issue.keys[0])}`;
    return `${at || 'recipe'}: ${issue.message}`;
}

function recipeEnvironmentError(env: Record<string, string>, prefix: string): string | undefined {
    for (const [k, v] of Object.entries(env)) {
        if (!ENV_NAME.test(k)) return `${prefix}: bad name ${JSON.stringify(k)}`;
        if (isControlEnv(k)) return `${prefix}.${k} changes what runs, not how the app is configured; a recipe never sets it`;
        if ((SECRET_NAME.test(k) && !(RECIPE_TEST_VALUES as readonly string[]).includes(v)) || SECRET_VALUE.test(v)) return `${prefix}.${k} looks like a secret; secrets never go in the recipe`;
        if (/[\n\r]/.test(v)) return `${prefix}.${k} has a newline`;
    }
    return undefined;
}

export const RECIPE_NEEDS_SHAPE = 'services.needs must be a list of repositories (- repo: owner/name, alias: name)';

/**
 * services.needs with each alias resolved (the repository's short name when
 * none is given), or why it is refused: a repository is owner/name, each
 * repository and each alias once. The cell resolves the same (recipe.go).
 */
function resolveNeeds(needs: ReadonlyArray<{ repo: string; alias?: string }>): RecipeNeed[] | string {
    const repos = new Set<string>();
    const aliases = new Set<string>();
    const out: RecipeNeed[] = [];
    for (const [i, n] of needs.entries()) {
        const at = `services.needs[${i}]`;
        if (n.repo.length > MAX_REPOSITORY_FULL_NAME || !REPOSITORY_FULL_NAME_PATTERN.test(n.repo)) return `${at}.repo: ${JSON.stringify(n.repo)} must be owner/name`;
        if (n.alias !== undefined && !REPOSITORY_ALIAS_PATTERN.test(n.alias)) return `${at}.alias: ${JSON.stringify(n.alias)} must match ${REPOSITORY_ALIAS_PATTERN.source}`;
        const alias = n.alias ?? repositoryAliasOf(n.repo);
        const repo = n.repo.toLowerCase();
        if (repos.has(repo)) return `${at}: ${n.repo} twice`;
        if (aliases.has(alias)) return `${at}: alias ${alias} twice`;
        repos.add(repo);
        aliases.add(alias);
        out.push({ repo: n.repo, alias });
    }
    return out;
}

/**
 * Why services.needs cannot boot beside the environment's own repository, or
 * undefined: a need never names that repository, nor takes its alias.
 */
export function recipeNeedsConflict(needs: readonly RecipeNeed[] | undefined, primary: { fullName: string; alias: string }): string | undefined {
    for (const [i, n] of (needs ?? []).entries()) {
        if (n.repo.toLowerCase() === primary.fullName.toLowerCase()) return `services.needs[${i}]: ${n.repo} is the environment's own repository`;
        if (n.alias === primary.alias) return `services.needs[${i}]: alias ${n.alias} is the environment's own repository's`;
    }
    return undefined;
}

// A flag that needs Cypress Cloud, whose secret a shard is never given. `--record-video` is not one.
const CLOUD_FLAGS: Record<(typeof SUITE_RUNNERS)[number], readonly string[]> = {
    cypress: ['--record', '--parallel', '--key', '--ci-build-id'],
    playwright: ['--record', '--parallel'],
};

/** Why a suite block is refused, or undefined (the cell enforces the same in suite.go). */
function suiteRules(s: RecipeSuite): string | undefined {
    if (Buffer.byteLength(s.command, 'utf8') > SUITE_LIMITS.commandBytes) return `suite.command: at most ${SUITE_LIMITS.commandBytes} bytes`;
    for (const flag of CLOUD_FLAGS[s.runner]) {
        if (new RegExp(`(^|\\s)${flag}(?=[=\\s]|$)`).test(s.command)) return `suite.command: ${flag} needs Cypress Cloud; a shard is given no record key`;
    }
    if (s.runner === 'cypress' && !s.command.includes('{specs}')) return 'suite.command: a cypress command needs {specs}';
    if (Object.keys(s.env).length > SUITE_LIMITS.env) return `suite.env: at most ${SUITE_LIMITS.env} entries`;
    const env = recipeEnvironmentError(s.env, 'suite.env');
    if (env) return env;
    if ('CYPRESS_RECORD_KEY' in s.env) return 'suite.env.CYPRESS_RECORD_KEY needs Cypress Cloud; a shard is given no record key';
    if (s.cwd !== undefined && !insideRepo(s.cwd)) return `suite.cwd: ${JSON.stringify(s.cwd)} must be a path inside the repo`;
    if (!insideRepo(s.specs)) return `suite.specs: ${JSON.stringify(s.specs)} must be a path inside the repo`;
    if (s.service !== undefined && !NAME.test(s.service)) return `suite.service: bad service ${JSON.stringify(s.service)}`;
    if (s.service !== undefined && s.image !== undefined) return 'suite: service and image together; use one';
    // The engine does not turn an image into a service: the environment's compose file holds the services (docs/runtime/e2e-suites.md section 4).
    if (s.image !== undefined) return "suite.image: not supported yet; add the image as a service of the environment's compose file and name it with suite.service";
    for (const [k, v] of Object.entries(s.timeoutSeconds ?? {})) {
        if (!(v > 0 && v <= SUITE_LIMITS.maxTimeoutSeconds)) return `suite.timeout.${k}: use a duration from 1s to 2h`;
    }
    if (s.results?.junit !== undefined && !insideRepo(s.results.junit)) return `suite.results.junit: ${JSON.stringify(s.results.junit)} must be a path inside the repo`;
    if ((s.results?.artifacts.length ?? 0) > SUITE_LIMITS.artifacts) return `suite.results.artifacts: at most ${SUITE_LIMITS.artifacts} paths`;
    for (const a of s.results?.artifacts ?? []) if (!insideRepo(a)) return `suite.results.artifacts: ${JSON.stringify(a)} must be a path inside the repo`;
    return undefined;
}

/** The rules every cell enforces (validate.go), in its order, on the resolved recipe. */
function recipeRules(r: Recipe): string | undefined {
    if (r.filesCopy.length) return 'files.copy is refused in a cell: env files never go to the machine; use a fake';
    if (r.composeFiles.length > RECIPE_LIMITS.composeFiles) return `services.compose.files: at most ${RECIPE_LIMITS.composeFiles} files`;
    for (const f of r.composeFiles) if (!insideRepo(f)) return `services.compose.files: ${JSON.stringify(f)} must be a path inside the repo`;
    if (r.profiles.length > RECIPE_LIMITS.profiles) return `services.compose.profiles: at most ${RECIPE_LIMITS.profiles}`;
    for (const p of r.profiles) if (!NAME.test(p)) return `services.compose.profiles: bad profile ${JSON.stringify(p)}`;
    if (r.public.length > RECIPE_LIMITS.public) return `services.compose.public: at most ${RECIPE_LIMITS.public} services`;
    const seen = new Set<string>();
    for (const s of r.public) {
        if (!NAME.test(s)) return `services.compose.public: bad service ${JSON.stringify(s)}`;
        if (seen.has(s)) return `services.compose.public: ${s} twice`;
        seen.add(s);
    }
    if (r.publicPort !== undefined && r.publicPort !== 0) {
        if (r.public.length > 1) return 'services.compose.public_port cannot be used with a list of public services';
        if (r.publicPort < 1 || r.publicPort > 65_535) return `services.compose.public_port: bad port ${r.publicPort}`;
    }
    const invalidEnv = recipeEnvironmentError(r.env, 'services.compose.env');
    if (invalidEnv) return invalidEnv;
    if (r.expose.length > RECIPE_LIMITS.exposed) return `services.expose: at most ${RECIPE_LIMITS.exposed} entries`;
    const exposed = new Set<string>();
    for (const [i, e] of r.expose.entries()) {
        if (!e.service) return `services.expose[${i}]: service required`;
        if (e.port < 1 || e.port > 65_535) return `services.expose[${i}]: bad port ${e.port}`;
        const k = `${e.service}/${e.port}`;
        if (exposed.has(k)) return `services.expose[${i}]: ${k} twice`;
        exposed.add(k);
    }
    if (r.health !== undefined) {
        if (!HEALTH_PATH.test(r.health) || r.health.length > RECIPE_LIMITS.healthLength)
            return `services.compose.health ${JSON.stringify(r.health)} must be a path`;
        if (!r.expose.some((e) => e.service === r.public[0] && e.kind === 'http')) {
            return 'services.compose.health needs services.compose.public with an http entry in services.expose';
        }
    }
    if (r.seed?.sql !== undefined && !insideRepo(r.seed.sql)) return `data.seed.sql: ${JSON.stringify(r.seed.sql)} must be a path inside the repo`;
    return undefined;
}

/**
 * Parses and validates a recipe the way the cell does: the same keys, Runo's
 * short forms resolved, the same refusals. Errors start with "recipe: ".
 */
export function parseRecipe(text: string): RecipeParseResult {
    const fail = (error: string): RecipeParseResult => ({ ok: false, error: `recipe: ${error}` });
    if (!text.trim()) return fail('empty');
    let doc: unknown;
    try {
        doc = yaml.load(text, { ...UNTRUSTED_YAML, schema: yaml.CORE_SCHEMA });
    } catch (e) {
        return fail(
            String((e as Error)?.message ?? e)
                .split('\n')[0]
                .slice(0, 200),
        );
    }
    if (doc === undefined || doc === null) return fail('empty');
    if (!isMap(doc)) return fail('the document must be a mapping');
    if (doc.version !== 1) return fail(`version must be 1, got ${JSON.stringify(doc.version ?? null)}`);
    const unsafeFakeInput = rawFakeInputError(doc.fakes);
    if (unsafeFakeInput) return fail(unsafeFakeInput);
    // Runo's services mode ({ db: { image }, app: { run } }) named before the strict check says "unknown field".
    if (isMap(doc.services)) {
        if (doc.services.needs !== undefined && !Array.isArray(doc.services.needs)) return fail(RECIPE_NEEDS_SHAPE);
        const other = Object.keys(doc.services)
            .sort()
            .find((k) => !['compose', 'expose', 'needs'].includes(k));
        if (other !== undefined) {
            return fail(
                `services.${other}: a cell boots a compose project (services.compose); Runo's services mode, a service with image or run, does not run in a cell`,
            );
        }
    }
    const parsed = RecipeSchema.safeParse(doc);
    if (!parsed.success) return fail(zodError(parsed.error.issues[0]));
    const d = parsed.data;
    const c = d.services?.compose ?? {};
    if (
        d.limits?.idle_suspend !== undefined &&
        recipeDurationSeconds(d.limits.idle_suspend) === undefined
    )
        return fail('limits.idle_suspend: invalid duration');
    const size = resolvedSize(d);
    if (typeof size === 'string') return fail(size);
    const hosts = (d.egress?.allow ?? []).map(recipeHost);
    if (hosts.some((h) => h === undefined))
        return fail(
            'egress.allow: use exact fully qualified DNS hosts without wildcard, IP, URL or port',
        );
    const egressAllow = [...new Set(hosts as string[])].sort();
    const fakes = normalizeRecipeFakes(d.fakes, Object.fromEntries(Object.entries(c.env ?? {}).map(([k, v]) => [k, str(v)])), recipeEnvironmentError);
    if (typeof fakes === 'string') return fail(fakes);
    if (c.file && c.files?.length) return fail('services.compose: file and files together; use one');
    const needs = resolveNeeds(d.services?.needs ?? []);
    if (typeof needs === 'string') return fail(needs);
    let healthTimeoutSeconds: number | undefined;
    if (c.health_timeout !== undefined) {
        const seconds = recipeDurationSeconds(c.health_timeout);
        if (seconds === undefined) return fail(`bad duration ${JSON.stringify(c.health_timeout)}`);
        // The wait a setup gives, which is what the resolved recipe says (recipe.HealthTimeout in the cell).
        // Zero leaves it unset, so the setup's default applies, as in the cell.
        if (seconds > 0) healthTimeoutSeconds = Math.min(seconds, MAX_HEALTH_TIMEOUT_SECONDS);
    }
    let seed: Recipe['seed'];
    const s = d.data?.seed;
    if (typeof s === 'string') seed = s ? { command: s } : undefined;
    else if (s) {
        const hasSql = str(s.sql) !== '';
        const hasCommand = str(s.command) !== '';
        if (str(s.service) === '' || hasSql === hasCommand) return fail('data.seed: a mapping needs service and exactly one of sql or command');
        seed = {
            service: str(s.service),
            ...(hasSql ? { sql: str(s.sql) } : { command: str(s.command) }),
            ...(str(s.user) ? { user: str(s.user) } : {}),
            ...(str(s.database) ? { database: str(s.database) } : {}),
        };
    }
    let suite: RecipeSuite | undefined;
    if (d.suite) {
        const x = d.suite;
        const timeoutSeconds: NonNullable<RecipeSuite['timeoutSeconds']> = {};
        for (const k of ['shard', 'spec', 'total'] as const) {
            if (x.timeout?.[k] === undefined) continue;
            const seconds = recipeDurationSeconds(x.timeout[k]);
            if (seconds === undefined) return fail(`suite.timeout.${k}: bad duration ${JSON.stringify(x.timeout[k])}`);
            timeoutSeconds[k] = seconds;
        }
        suite = {
            runner: x.runner,
            command: x.command,
            ...(x.cwd !== undefined ? { cwd: x.cwd } : {}),
            specs: x.specs,
            ...(x.shards !== undefined ? { shards: x.shards } : {}),
            ...(x.service !== undefined ? { service: x.service } : {}),
            ...(x.image !== undefined ? { image: x.image } : {}),
            ...(Object.keys(timeoutSeconds).length ? { timeoutSeconds } : {}),
            env: Object.fromEntries(Object.entries(x.env ?? {}).map(([k, v]) => [k, str(v)])),
            ...(x.results ? { results: { ...(x.results.junit !== undefined ? { junit: x.results.junit } : {}), artifacts: x.results.artifacts ?? [] } } : {}),
            baseline: x.baseline ?? true,
            ignore: x.ignore ?? [],
            ...(x.retries?.main !== undefined ? { retriesMain: x.retries.main } : {}),
            gate: x.gate ?? 'default',
        };
        const refused = suiteRules(suite);
        if (refused) return fail(refused);
    }
    const recipe: Recipe = {
        version: 1,
        ...(d.validate !== undefined ? { validate: d.validate } : {}),
        composeFiles: c.file ? [c.file] : (c.files ?? []),
        profiles: c.profiles ?? [],
        public: c.public === undefined ? [] : typeof c.public === 'string' ? [c.public] : c.public,
        ...(c.public_port !== undefined ? { publicPort: c.public_port } : {}),
        ...(c.health ? { health: c.health } : {}),
        ...(healthTimeoutSeconds !== undefined ? { healthTimeoutSeconds } : {}),
        env: Object.fromEntries(Object.entries(c.env ?? {}).map(([k, v]) => [k, str(v)])),
        expose: (d.services?.expose ?? []).map((e) => ({ service: e.service, port: e.port, kind: e.kind })),
        ...(d.data?.migrate ? { migrate: d.data.migrate } : {}),
        ...(seed ? { seed } : {}),
        filesCopy: d.files?.copy ?? [],
        ...(size ? { size } : {}),
        ...(d.egress ? { egressAllow } : {}),
        ...(d.fakes ? { fakes } : {}),
        ...((d.services?.expose ?? []).some((e) => e.readonly_user_from_seed === true) ? { seededSQL: true as const } : {}),
        ...(needs.length ? { needs } : {}),
        ...(suite ? { suite } : {}),
    };
    const unapplied: string[] = RECIPE_UNAPPLIED_KEYS.filter((k) => d[k] !== undefined);
    if (d.limits)
        for (const k of ['instance', 'idle_suspend', 'idle_activity'] as const)
            if (d.limits[k] !== undefined) unapplied.push(`limits.${k}`);
    if (unapplied.length) recipe.unapplied = unapplied;
    const broken = recipeRules(recipe);
    return broken ? fail(broken) : { ok: true, recipe };
}

/** The JSON Schema of the recipe, for editors (yaml-language-server) and the agent that writes recipes. */
export function recipeJsonSchema(): Record<string, unknown> {
    return {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        title: '.kodus/workspace.yaml',
        description: 'The environment recipe Runo and the Kody Runtime read. Secrets never go here; a cell also refuses files.copy.',
        ...z.toJSONSchema(RecipeSchema, { io: 'input', unrepresentable: 'any' }),
    };
}
