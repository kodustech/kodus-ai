import type { FailureBundle } from '@libs/runtime/protocol';
import { MAX_HEALTH_TIMEOUT_SECONDS } from '@libs/runtime/protocol/recipe';

// The classifier of blockers and its catalog of fixes (docs §4, ADR-015):
// what blocked an environment, read from what the cell and the worker saw
// (the kind and signature, the reason and the redacted failure bundle),
// becomes one of the typed kinds, a stable signature that groups it in
// Environment Health, a plain-language title and the fixes in order, the
// first one recommended. Deterministic rules only; an unknown stays unknown.
//
// Everything here is a template filled with structured fields (S-23): a
// title or a fix never carries repository text beyond an identifier the
// rule extracted and checked (an env var name, a host, a service, a port).

export type BlockerKindView =
    | 'missing_env'
    | 'external_service'
    | 'toolchain'
    | 'native_dep'
    | 'resources'
    | 'seed_data'
    | 'other_repo'
    | 'platform'
    | 'recipe_outdated'
    | 'not_ready'
    | 'security_violation'
    | 'unknown';

export type FixAction =
    /** Approve an outbound host for the environment; kept outside the recipe (§10). */
    | 'approve_host'
    /** Ask for the setup again: the failure was Kodus's, not the repo's. */
    | 'retry_setup'
    /** Give the app a test value for an env var, through a recipe PR. */
    | 'set_env'
    /** Give the ready check more time, through a recipe PR. */
    | 'raise_health_timeout'
    | 'pin_version'
    | 'add_packages'
    | 'bump_machine'
    | 'use_mock'
    | 'add_seed_step'
    | 'fix_recipe'
    | 'fix_listen_address'
    /** Kody's learn loop only (blockers/hypothesis.ts): point the ready check at another path, through a recipe PR. */
    | 'set_health_path'
    /** Kody's learn loop only: make another exposed http service the public one, through a recipe PR. */
    | 'set_public_service'
    /** Connect a cell of the organization's own: its claims there take no slot of the shared Kodus cells. */
    | 'use_own_cell';

/**
 * Who makes a fix, and where: Kody, Kodus in one click, the dev in the
 * repository (`dev`), or the dev in Kodus's own settings (`settings`: the
 * machine size, a cell of the org's own). A reader that does not know
 * `settings` yet tells those fixes apart by their action.
 */
export type FixWho = 'kody' | 'one_click' | 'dev' | 'settings';

/** The fixes Kodus applies by opening a PR with a one-field recipe change. */
export const RECIPE_PR_ACTIONS = ['set_env', 'raise_health_timeout', 'set_health_path', 'set_public_service'] as const;
export type RecipePrAction = (typeof RECIPE_PR_ACTIONS)[number];
export const isRecipePrAction = (a: FixAction): a is RecipePrAction => (RECIPE_PR_ACTIONS as readonly string[]).includes(a);
/** The id prefix of a fix Kody's learn loop proved; the product adds it to the card from the setup record. */
export const KODY_FIX_PREFIX = 'kody:';

/** A recipe change a fix proposes: the field it sets, always under services.compose. */
export type RecipeChange = {
    path: ['env', string] | ['health_timeout'] | ['health'] | ['public'];
    value: string;
};

export interface BlockerFixView {
    /** Stable per blocker: action plus its parameter. */
    id: string;
    action: FixAction;
    who: FixWho;
    label: string;
    /** What the dev does, in a sentence; for `dev` fixes, the whole fix. */
    detail?: string;
    /** For approve_host. */
    host?: string;
    /** For recipe fixes: applied by a PR on the recipe, shown as a diff first (ENV-05). */
    recipeChange?: RecipeChange;
}

export interface BlockerEvidence {
    /** The log lines that matched, redacted by the cell. */
    lines: string[];
    service?: string;
}

export interface ClassifiedBlocker {
    kind: BlockerKindView;
    signature: string;
    title: string;
    evidence: BlockerEvidence;
    fixes: BlockerFixView[];
}

export interface BlockerInput {
    kind: string;
    signature: string;
    message: string;
    bundle?: FailureBundle;
}

/**
 * The longest wait a fix proposes for the ready check: the most a setup
 * waits, which the recipe contract owns (the parser caps health_timeout at
 * it). Re-exported for the worker's ready check.
 */
export { MAX_HEALTH_TIMEOUT_SECONDS };

// Owned here, written by the worker's ready check and read by the not_ready card below.
const CUT_BY_CEILING = ", when the setup's machine time ran out";
/**
 * The ready check's "after N s" in a not_ready message. `cutByCeiling`: the
 * setup claim's hardExpiresAt ended the wait before health_timeout did, so a
 * longer health_timeout would be cut the same way and the card proposes none.
 */
export const notReadyWaited = (seconds: number, cutByCeiling: boolean): string => ` after ${seconds} s${cutByCeiling ? CUT_BY_CEILING : ''}`;

const raiseHealthTimeout = (seconds: number): BlockerFixView => ({
    id: 'raise_health_timeout',
    action: 'raise_health_timeout',
    who: 'dev',
    label: 'Give the app more time to start',
    detail: `Opens a PR on the recipe that waits up to ${seconds / 60} minutes for the ready check. If it never answers, check services.compose.health points at a path that returns 200.`,
    recipeChange: { path: ['health_timeout'], value: `${seconds}s` },
});

const ENV_NAME = /^[A-Z][A-Z0-9_]{1,63}$/;
const HOST = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const SERVICE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/;

/**
 * A test value never looks like a real secret: it names itself. The cell takes
 * exactly these two under a name that looks like a secret (SESSION_SECRET) and
 * refuses any other value there (apps/runtime-cell/internal/recipe/validate.go testValues).
 */
export const testValueFor = (name: string) => (/_URL$|_URI$|_HOST$/.test(name) ? 'http://kodus-fake.invalid' : 'kodus-test-value');

/** Hosts a build installs packages or images from: no fake replaces them. */
const PACKAGE_REGISTRY = /(^|\.)(proxy\.golang\.org|sum\.golang\.org|registry\.npmjs\.org|registry\.yarnpkg\.com|pypi\.org|files\.pythonhosted\.org|repo\.maven\.apache\.org|repo1\.maven\.org|dl-cdn\.alpinelinux\.org|deb\.debian\.org|security\.debian\.org|archive\.ubuntu\.com|ports\.ubuntu\.com|registry-1\.docker\.io|auth\.docker\.io|ghcr\.io|quay\.io|crates\.io|static\.crates\.io|rubygems\.org|api\.nuget\.org)$/;

export const isPackageRegistry = (host: string) => PACKAGE_REGISTRY.test(host.toLowerCase());

const retry: BlockerFixView = {
    id: 'retry_setup',
    action: 'retry_setup',
    who: 'one_click',
    label: 'Run the setup again',
    detail: 'The failure was on the Kodus side, not in your repository. A new setup usually gets past it.',
};

const useOwnCell: BlockerFixView = {
    id: 'use_own_cell',
    action: 'use_own_cell',
    who: 'settings',
    label: 'Run it on a cell of your own',
    detail: 'Register a cell of your organization under Cells: its machines serve only your environments, and no limit of the shared Kodus cells applies there.',
};

/** The environment's Machine size setting (contracts/machine-size.ts), and a self-hosted cell's own bounds. */
const largerMachine = (detail: string): BlockerFixView => ({
    id: 'bump_machine',
    action: 'bump_machine',
    who: 'settings',
    label: 'Give the environment a larger machine',
    detail,
});

const SELF_HOSTED_MEMORY =
    'On your own cell, a claim gets at most -gvisor-mem-max and -gvisor-cpus-max, and -gvisor-mem-limit when it asks no size: raise them on a machine that has the memory.';

/** A docker memory value as a person reads it: 12288m and 12g are 12 GB. */
const memoryLabel = (limit: string) => {
    const m = /^(\d+)([mg])$/i.exec(limit);
    if (!m) return limit;
    const gb = m[2].toLowerCase() === 'g' ? Number(m[1]) : Number(m[1]) / 1_024;
    return Number.isInteger(gb) ? `${gb} GB` : limit;
};

const fixRecipe = (detail: string): BlockerFixView => ({
    id: 'fix_recipe',
    action: 'fix_recipe',
    who: 'dev',
    label: 'Fix the recipe',
    detail,
});

const PLATFORM_STEPS: Record<string, string> = {
    org_key: 'getting the organization key',
    claim_keys: 'issuing the machine keys',
    claim_network: 'creating the machine network',
    create_workload: 'creating the machine',
    create_observer: 'creating the observer machine',
    repo_source: 'reaching the repository',
    repo_fetch: 'downloading the repository',
    repo_upload: 'copying the repository to the machine',
    workdir: 'preparing the work directory',
    egress_policy: 'applying the outbound policy',
    cell_lost: 'keeping the cell connected during the boot',
};

type Line = { service?: string; text: string };

const linesOf = (input: BlockerInput): Line[] => {
    const out: Line[] = [];
    for (const s of input.bundle?.services ?? []) for (const text of s.logTail) out.push({ service: s.name, text });
    out.push({ text: input.message });
    return out;
};

type Rule = (line: Line) => Omit<ClassifiedBlocker, 'evidence'> | null;

const first = (lines: Line[], rule: Rule) => {
    // The newest line is the closest to the failure: read from the end.
    for (let i = lines.length - 1; i >= 0; i -= 1) {
        const hit = rule(lines[i]);
        if (hit) return { hit, line: lines[i] };
    }
    return null;
};

const MISSING_ENV = [
    /missing (?:required )?env(?:ironment)? var(?:iable)?s?:?\s*["'`]?([A-Z][A-Z0-9_]+)/i,
    /env(?:ironment)? var(?:iable)? ["'`]?([A-Z][A-Z0-9_]+)["'`]? (?:is )?(?:not set|missing|required|undefined)/i,
    /\b([A-Z][A-Z0-9_]{2,}) (?:is not set|is required|must be set|is not defined)\b/,
    /"([A-Z][A-Z0-9_]{2,})":\s*\[?\s*"Required"/,
];

const missingEnv: Rule = ({ text }) => {
    for (const re of MISSING_ENV) {
        const name = re.exec(text)?.[1];
        if (name && ENV_NAME.test(name)) {
            return {
                kind: 'missing_env',
                signature: `missing_env:${name}`,
                title: `The app needs ${name}, which the environment doesn't set`,
                fixes: [
                    {
                        id: `set_env:${name}`,
                        action: 'set_env',
                        who: 'dev',
                        label: `Give ${name} a test value in the recipe`,
                        detail: `Opens a PR on the recipe that sets ${name} for the machine only. Never put a real secret there: if the app calls a service with it, point it at a fake.`,
                        recipeChange: {
                            path: ['env', name],
                            value: testValueFor(name),
                        },
                    },
                    {
                        id: `use_mock:${name}`,
                        action: 'use_mock',
                        who: 'dev',
                        label: 'Point it at a fake service',
                        detail: `If ${name} reaches an outside service, add a fake to the compose (stripe-mock, Mailpit, a local S3) and set ${name} to it.`,
                    },
                ],
            };
        }
    }
    return null;
};

const oom: Rule = ({ text, service }) =>
    /JavaScript heap out of memory|OOMKilled|exit(?:ed)? (?:with )?(?:code )?137\b|Out of memory: Killed/i.test(text)
        ? {
              kind: 'resources',
              signature: `resources:memory${service ? `:${service}` : ''}`,
              title: `${service ? `The ${service} service` : 'The app'} ran out of memory`,
              fixes: [
                  largerMachine(
                      "In the environment's Machine size, choose Medium (8 GB) or Large (16 GB) and run the setup again. Or lower what it needs: NODE_OPTIONS=--max-old-space-size or a smaller worker count in the compose.",
                  ),
                  retry,
              ],
          }
        : null;

const disk: Rule = ({ text }) =>
    /no space left on device/i.test(text)
        ? {
              kind: 'resources',
              signature: 'resources:disk',
              title: 'The machine ran out of disk',
              fixes: [retry],
          }
        : null;

const toolchain: Rule = ({ text }) => {
    const node = /engine "node" is incompatible[^"]*"([^"]{1,40})"|requires? node(?:\.js)? (?:version )?([<>=~^ 0-9.x|]{1,40})/i.exec(text);
    if (node) {
        const range = (node[1] ?? node[2] ?? '').trim();
        return {
            kind: 'toolchain',
            signature: 'toolchain:node',
            title: `The project needs another Node version${range ? ` (${range})` : ''}`,
            fixes: [
                {
                    id: 'pin_version:node',
                    action: 'pin_version',
                    who: 'dev',
                    label: 'Use the Node version the project asks for',
                    detail: `Change the node image in the Dockerfile the recipe builds${range ? ` to one that satisfies ${range}` : ''}, the same one your CI uses.`,
                },
            ],
        };
    }
    const go = /go\.mod requires go >= ?([0-9.]{1,12})/.exec(text);
    if (go) {
        return {
            kind: 'toolchain',
            signature: 'toolchain:go',
            title: `The project needs Go ${go[1]} or later`,
            fixes: [
                {
                    id: 'pin_version:go',
                    action: 'pin_version',
                    who: 'dev',
                    label: `Build with Go ${go[1]}`,
                    detail: `Use golang:${go[1]} (or later) as the build image in the Dockerfile.`,
                },
            ],
        };
    }
    const py = /requires a different Python|Requires-Python ([<>=~!0-9., ]{1,40})/.exec(text);
    if (py) {
        return {
            kind: 'toolchain',
            signature: 'toolchain:python',
            title: 'The project needs another Python version',
            fixes: [
                {
                    id: 'pin_version:python',
                    action: 'pin_version',
                    who: 'dev',
                    label: 'Use the Python version the project asks for',
                    detail: 'Change the python image in the Dockerfile to the version in pyproject.toml.',
                },
            ],
        };
    }
    return null;
};

const nativeDep: Rule = ({ text }) => {
    const header = /fatal error: ([A-Za-z0-9_/.+-]{1,80}\.h): No such file/.exec(text)?.[1];
    const pkg = /Package '?([A-Za-z0-9_.+-]{1,64})'? was not found in the pkg-config/.exec(text)?.[1];
    const lib = /cannot find -l([A-Za-z0-9_.+-]{1,64})/.exec(text)?.[1];
    const what = header ?? pkg ?? lib;
    if (!what && !/gyp ERR!|error: command '(?:gcc|cc|x86_64-linux-gnu-gcc)' failed/.test(text)) return null;
    return {
        kind: 'native_dep',
        signature: `native_dep:${what ?? 'build'}`,
        title: what ? `A native build needs ${what}, which the image doesn't have` : 'A native module failed to compile',
        fixes: [
            {
                id: `add_packages:${what ?? 'build'}`,
                action: 'add_packages',
                who: 'dev',
                label: 'Install the system package in the Dockerfile',
                detail: what
                    ? `Add the package that provides ${what} to the apt-get or apk line of the Dockerfile (often the -dev package of the same name).`
                    : 'Add build-essential and python3 (or the alpine build-base) to the Dockerfile stage that runs the install.',
            },
        ],
    };
};

// The lockfile does not match the manifests: an install that may not change it
// (yarn --immutable, npm ci, pnpm --frozen-lockfile) refuses. Fixed in the repo.
const lockfileOutdated: Rule = ({ text }) => {
    const m =
        /(The lockfile would have been modified by this install)|(`npm ci` can only install packages when your package\.json and package-lock\.json[^\n]* are in sync)|(ERR_PNPM_OUTDATED_LOCKFILE)/.exec(
            text,
        );
    if (!m) return null;
    const tool = m[1] ? 'yarn' : m[2] ? 'npm' : 'pnpm';
    return {
        kind: 'toolchain',
        signature: `toolchain:lockfile_outdated:${tool}`,
        title: `The ${tool} lockfile does not match the package manifests`,
        fixes: [
            fixRecipe(
                `Run ${tool} install on the default branch and commit the updated lockfile. The build installs with the lockfile frozen, as CI does, so it refuses one that would change.`,
            ),
        ],
    };
};

// The cell's mirror serves only what go.sum pins: a module it refused is not
// in any go.sum of the repository (or the build asked for a newer one).
const goModuleNotPinned: Rule = ({ text }) => {
    const m = /([a-z0-9][a-z0-9._~\/-]{1,200})@(v[0-9A-Za-z.+-]{1,64}) is not pinned by this claim's go\.sum/.exec(text);
    if (!m) return null;
    return {
        kind: 'toolchain',
        signature: `toolchain:go_module_not_pinned:${m[1]}`,
        title: `${m[1]}@${m[2]} is not in the repository's go.sum`,
        fixes: [
            fixRecipe(
                `Run go mod tidy on the default branch and commit go.sum. The cell's registry mirror serves only the modules go.sum pins, so a build that needs another one (or runs go get) stops here.`,
            ),
        ],
    };
};

const seedData: Rule = ({ text }) => {
    const table = /relation "([A-Za-z0-9_.]{1,80})" does not exist|no such table: ([A-Za-z0-9_.]{1,80})|Table '([A-Za-z0-9_.]{1,80})' doesn't exist/.exec(text);
    if (!table) return null;
    const name = table[1] ?? table[2] ?? table[3];
    return {
        kind: 'seed_data',
        signature: 'seed_data:schema',
        title: `The database has no schema yet (table ${name} is missing)`,
        fixes: [
            {
                id: 'add_seed_step',
                action: 'add_seed_step',
                who: 'dev',
                label: 'Run the migrations in the recipe',
                detail: 'Set data.migrate in .kodus/workspace.yaml to the command your CI uses (for example npm run migrate), so the database is ready before the app starts.',
            },
        ],
    };
};

/**
 * Go verifying a module the build added against the checksum database
 * (go work sync, go get): the sandbox reaches only the cell's mirror, so a
 * lookup of sum.golang.org fails. Kodus's gap, not the repository's.
 */
const goChecksumDb: Rule = ({ text }) => {
    const m = /verifying (?:module: )?([A-Za-z0-9][A-Za-z0-9._~\/-]{1,200})@(v[0-9A-Za-z.+-]{1,64})[^\n]{0,200}sum\.golang\.org/.exec(text);
    if (!m) return null;
    return {
        kind: 'platform',
        signature: 'platform:go_checksum_db',
        title: `The build checks ${m[1]}@${m[2]} against the Go checksum database, which the sandbox does not reach`,
        fixes: [retry],
    };
};

const unreachable: Rule = ({ text }) => {
    const m =
        /ECONNREFUSED ([A-Za-z0-9.-]{1,253}):(\d{1,5})|getaddrinfo (?:ENOTFOUND|EAI_AGAIN) ([A-Za-z0-9.-]{1,253})|lookup ([A-Za-z0-9.-]{1,253})(?: on [0-9a-fA-F.:\[\]]{1,64})?: no such host|Could not resolve host: ([A-Za-z0-9.-]{1,253})/.exec(
            text,
        );
    if (!m) return null;
    const host = (m[1] ?? m[3] ?? m[4] ?? m[5]).toLowerCase();
    if (host === '127.0.0.1' || host === 'localhost' || host === '::1') {
        return {
            kind: 'external_service',
            signature: `external_service:localhost:${m[2] ?? ''}`,
            title: `The app expects a service on localhost${m[2] ? `:${m[2]}` : ''}`,
            fixes: [
                {
                    id: 'use_mock:localhost',
                    action: 'use_mock',
                    who: 'dev',
                    label: 'Point it at the compose service',
                    detail: 'In the compose, the database or queue is reached by its service name, not localhost. Set the URL env var to the service name.',
                },
            ],
        };
    }
    return {
        kind: 'external_service',
        signature: `external_service:${host}`,
        title: `The app can't reach ${host}`,
        fixes: [
            {
                id: `use_mock:${host}`,
                action: 'use_mock',
                who: 'dev',
                label: 'Add it to the compose, or a fake of it',
                detail: `If ${host} is one of your services, add it to the compose. If it is an outside API, use a fake and point the app at it with an env var.`,
            },
        ],
    };
};

const LOG_RULES: Rule[] = [lockfileOutdated, goModuleNotPinned, goChecksumDb, missingEnv, toolchain, nativeDep, oom, disk, seedData, unreachable];

/**
 * The one log line the log rules of classifyBlocker read the cause from: the
 * same rule order and the same reading (the reason first, as one text, then
 * the bundle's lines newest first), narrowed to the line of the reason that
 * holds the match (a build's output is one multi-line reason). It is the
 * excerpt a boot failure shows. Undefined when no rule reads it, or the match
 * spans lines; the caller then falls back to its own reading.
 */
export function matchedBlockerLine(input: Pick<BlockerInput, 'message' | 'bundle'>): string | undefined {
    const message = input.message ?? '';
    const bundled: Line[] = [];
    for (const s of input.bundle?.services ?? []) for (const text of s.logTail) bundled.push({ service: s.name, text });
    for (const rule of LOG_RULES) {
        if (rule({ text: message })) return message.split(/\r?\n/).find((text) => rule({ text }) !== null);
        const found = first(bundled, rule);
        if (found) return found.line.text;
    }
    return undefined;
}

const evidenceOf = (line: Line | undefined): BlockerEvidence => ({
    lines: line ? [line.text.slice(0, 500)] : [],
    ...(line?.service ? { service: line.service } : {}),
});

/** The denied outbound hosts of the bundle, normalized and checked, at most three. */
const deniedHosts = (bundle?: FailureBundle, platform = false) =>
    [...new Set((bundle?.deniedEgress ?? []).filter((d) => !!d.platform === platform).map((d) => d.host.toLowerCase().replace(/\.$/, '')))]
        .filter((h) => HOST.test(h))
        .slice(0, 3);

export function classifyBlocker(input: BlockerInput): ClassifiedBlocker {
    const lines = linesOf(input);

    // Kodus's own steps: nothing in the repository to change.
    const step = PLATFORM_STEPS[input.signature];
    if (step && (input.kind === 'platform' || input.kind === 'resources')) {
        return {
            kind: input.kind,
            signature: input.signature,
            title: `Kodus failed while ${step}`,
            evidence: evidenceOf({ text: input.message }),
            fixes: [retry],
        };
    }
    if (input.kind === 'security_violation') {
        return {
            kind: 'security_violation',
            signature: input.signature,
            title: 'The run was stopped: code tried to send a credential out',
            evidence: evidenceOf({ text: input.message }),
            fixes: [],
        };
    }
    if (input.kind === 'recipe_outdated') {
        return {
            kind: 'recipe_outdated',
            signature: input.signature,
            title: "The recipe doesn't load",
            evidence: evidenceOf({ text: input.message }),
            fixes: [fixRecipe('Open .kodus/workspace.yaml on the default branch and fix the error shown here; the next setup reads it again.')],
        };
    }
    // services.needs: the cell refuses a recipe that boots other repositories beside this one
    // (what would run without them is not the app), before its project comes up.
    if (input.kind === 'other_repo' && input.signature === 'recipe_needs') {
        return {
            kind: 'other_repo',
            signature: input.signature,
            title: 'The recipe needs other repositories, which a cell does not boot yet',
            evidence: evidenceOf({ text: input.message }),
            fixes: [
                fixRecipe(
                    'Remove services.needs from .kodus/workspace.yaml on the default branch, and give the services it named a stand-in in the compose file (a fake under the same service name); the next setup boots without them.',
                ),
            ],
        };
    }
    // No recipe, no compose file, no Dockerfile: Kodus could not infer a recipe (setup step `recipe`).
    if (input.kind === 'no_recipe') {
        return {
            kind: 'recipe_outdated',
            signature: input.signature,
            title: 'Kodus found nothing to boot this repository from',
            evidence: evidenceOf({ text: input.message }),
            fixes: [
                fixRecipe(
                    'Add a compose file or a Dockerfile at the repository root, and the next setup infers a recipe from it. Or write .kodus/workspace.yaml yourself (docs §6).',
                ),
            ],
        };
    }

    // No cell took the boot: nothing ran, nothing in the repository to change.
    if (input.signature === 'cell_unavailable') {
        return {
            kind: 'platform',
            signature: 'cell_unavailable',
            title: 'No cell was connected to boot this environment',
            evidence: evidenceOf({ text: input.message }),
            fixes: [
                {
                    ...retry,
                    detail: 'Nothing booted and your repository is not the cause. On your own cell, check that it runs and shows as connected under Cells; then run the setup again.',
                },
            ],
        };
    }

    // Cells were connected but none could take the claim: nothing was sent to a cell,
    // nothing in the repository to change. Waiting frees a slot; an own cell is not shared.
    if (input.signature === 'org_capacity') {
        const cap = /\(cap (\d+)\)/.exec(input.message)?.[1];
        return {
            kind: 'resources',
            signature: 'org_capacity',
            title: cap
                ? `Your organization is using all ${cap} machines it may hold on shared Kodus cells`
                : 'Your organization is using all the machines it may hold on shared Kodus cells',
            evidence: evidenceOf({ text: input.message }),
            fixes: [
                {
                    ...retry,
                    label: 'Wait, then run it again',
                    detail: 'Nothing booted and your repository is not the cause. Your other runs and setups free their machines when they finish; run this one again then.',
                },
                useOwnCell,
            ],
        };
    }
    if (input.signature === 'no_capacity') {
        return {
            kind: 'resources',
            signature: 'no_capacity',
            title: 'Every cell that can run this environment is full',
            evidence: evidenceOf({ text: input.message }),
            fixes: [
                {
                    ...retry,
                    label: 'Wait, then run it again',
                    detail: 'Nothing booted and your repository is not the cause. Machines free up as other runs finish; run this one again in a few minutes.',
                },
                useOwnCell,
            ],
        };
    }

    // The boot outlived the setup's ceiling: a heavy build (a production image, every
    // service) is the repository's to trim; running it again only waits as long.
    if (input.signature === 'boot_timeout') {
        return {
            kind: 'resources',
            signature: 'boot_timeout',
            title: 'The boot takes longer than a setup waits',
            evidence: evidenceOf({ text: input.message }),
            fixes: [
                fixRecipe(
                    'Boot only what the PR needs: list the services in services.compose (a compose overlay or profiles), use a development build instead of the production one, and leave out frontends and workers the probes never call. A large compiled image exports faster in two stages, with its compile and module caches in RUN --mount=type=cache instead of a layer.',
                ),
            ],
        };
    }

    // The sandbox killed a build or a service at its memory limit (exit 137): a
    // larger machine size for the environment, or a lighter build.
    if (input.signature === 'out_of_memory') {
        const limit = /passed (\S+)/.exec(input.message)?.[1];
        return {
            kind: 'resources',
            signature: 'out_of_memory',
            title: limit ? `The build ran out of memory (${memoryLabel(limit)})` : 'The build ran out of memory',
            evidence: evidenceOf({ text: input.message }),
            fixes: [
                largerMachine(
                    `In the environment's Machine size, choose a larger size (Medium 8 GB, Large 16 GB: a heavy compiled build needs it) and run the setup again. ${SELF_HOSTED_MEMORY}`,
                ),
                fixRecipe(
                    'Build less at once: a development build instead of the production one, fewer parallel jobs (GOFLAGS=-p=2, NODE_OPTIONS=--max-old-space-size), and the compile caches in RUN --mount=type=cache instead of the image.',
                ),
                {
                    ...retry,
                    detail: 'Once a larger machine size is saved, run the setup again: it boots at the new size.',
                },
            ],
        };
    }

    // The environment asked a machine size above the largest a cell grants:
    // the cell refused it, or no connected cell grants it and the claim went
    // to none (the worker's routing). Nothing was created either way; the
    // evidence names what was asked and the most a cell grants. A smaller
    // size, or a cell that grants it.
    if (input.signature === 'size_unavailable') {
        return {
            kind: 'resources',
            signature: 'size_unavailable',
            title: 'No cell grants this machine size',
            evidence: evidenceOf({ text: input.message }),
            fixes: [
                {
                    ...largerMachine(
                        `In the environment's Machine size, choose a size within what the cell grants and run the setup again. ${SELF_HOSTED_MEMORY} A cell of a build older than machine sizes grants none until it is updated.`,
                    ),
                    label: 'Choose a machine size a cell grants',
                },
                useOwnCell,
            ],
        };
    }

    // Kody's recipe needs the build files it wrote, and the cell's build cannot write them:
    // nothing was sent. Booted without them, it would name files the checkout lacks.
    if (input.signature === 'authored_files_unsupported') {
        return {
            kind: 'platform',
            signature: 'authored_files_unsupported',
            title: 'This cell is too old for the build files Kody wrote',
            evidence: evidenceOf({ text: input.message }),
            fixes: [
                {
                    ...retry,
                    label: 'Update the cell, then run it again',
                    detail: "Nothing booted and your repository is not the cause. Kody's recipe builds from a Dockerfile or compose file it wrote under .kodus/, which only a newer cell writes into the checkout. On your own cell, update it to the current build; on Kodus cells, run the setup again once they are updated.",
                },
            ],
        };
    }

    // The cell would not write a build file Kody wrote: the checkout (a pull request's, for a Run)
    // already has that path, or its .kodus is a link. Nothing is followed or replaced (S-05).
    if (input.signature === 'authored_files') {
        const path = /authored file (\.kodus(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,63})?): /.exec(input.message)?.[1];
        const what = path === '.kodus' ? 'its .kodus is not a plain directory' : path ? `it already has ${path}` : 'it already has a path Kody writes';
        return {
            kind: 'toolchain',
            signature: 'authored_files',
            title: `Kody's build files could not be written: ${what}`,
            evidence: evidenceOf({ text: input.message }),
            fixes: [
                fixRecipe(
                    `Kody writes the Dockerfile and compose file of its recipe under .kodus/ of the checkout, never over a file the branch has and never through a link. Remove or rename ${path ?? 'that path'} on this branch, or merge the recipe pull request Kodus opens, which adds the same files to the repository.`,
                ),
            ],
        };
    }

    // An entry of the repository the cell refuses to unpack (S-05).
    if (input.signature === 'repo_refused') {
        const m = /refused "([^"]+)": ([^\n]+)/.exec(input.message);
        const entry = m?.[1]?.replace(/^[^/]+\//, '') ?? 'an entry';
        return {
            kind: 'toolchain',
            signature: 'repo_refused',
            title: `Kodus refuses to unpack ${entry} from the repository`,
            evidence: { lines: [m ? `${entry}: ${m[2]}` : input.message.slice(0, 300)] },
            fixes: [
                fixRecipe(
                    `The cell never unpacks a symlink that leaves the repository, a .git entry, a hard link or a device (S-05). Make ${entry} a regular file or a link inside the repository; nothing else in it needs to change.`,
                ),
            ],
        };
    }

    // A blocked outbound request is the most direct reading of a failed boot.
    const hosts = deniedHosts(input.bundle);
    // The platform deny list (cloud storage, paste and file-sharing sites): no
    // approval opens it, so the card says why and offers no "allow".
    const refused = deniedHosts(input.bundle, true);
    if (!hosts.length && refused.length) {
        const host = refused[0];
        return {
            kind: 'external_service',
            signature: `external_service:platform_denied:${host}`,
            title: `Kodus never lets the machine reach ${host}`,
            evidence: { lines: refused.map((h) => `outbound request to ${h} refused by the Kodus deny list`) },
            fixes: [
                {
                    id: `use_mirror:${host}`,
                    action: 'fix_recipe',
                    who: 'dev',
                    label: 'Install through the cell\'s registry mirror',
                    detail: `${host} is on the Kodus deny list (cloud storage, paste and file-sharing sites), and no approval opens it. A build that installs packages reaches them through the cell's mirror: declare ARG GOPROXY in the Dockerfile (the cell passes it), and the modules come from mirror.cell.internal. An app that calls ${host} at boot needs a fake.`,
                },
            ],
        };
    }
    if (hosts.length) {
        const host = hosts[0];
        return {
            kind: 'external_service',
            signature: `external_service:egress:${host}`,
            title: `The app tried to reach ${host}, which isn't allowed from the machine`,
            evidence: {
                lines: hosts.map((h) => `outbound request to ${h} blocked`),
            },
            fixes: [
                ...hosts.map((h): BlockerFixView => ({
                    id: `approve_host:${h}`,
                    action: 'approve_host',
                    who: 'one_click',
                    host: h,
                    label: `Allow ${h} and set up again`,
                    detail: 'Kept for this environment only, outside the recipe. Only allow hosts the app needs to boot; an outside API is better replaced by a fake.',
                })),
                // A fake stands in for an API the app calls, never for a registry the build installs from.
                ...(isPackageRegistry(host)
                    ? []
                    : [
                          {
                              id: `use_mock:${host}`,
                              action: 'use_mock' as const,
                              who: 'dev' as const,
                              label: 'Use a fake instead',
                              detail: `Add a fake of ${host} to the compose and point the app at it with an env var.`,
                          },
                      ]),
            ],
        };
    }

    for (const rule of LOG_RULES) {
        const found = first(lines, rule);
        if (found) return { ...found.hit, evidence: evidenceOf(found.line) };
    }

    if (input.kind === 'not_ready') {
        const m = /^setup:not_ready:([^:]+):(\d+)(\/.*)?$/.exec(input.signature);
        const service = m && SERVICE.test(m[1]) ? m[1] : undefined;
        const port = m ? Number(m[2]) : undefined;
        const notListening = input.bundle?.ports.find((p) => p.service === service && p.port === port && !p.listening);
        if (notListening && service && port) {
            return {
                kind: 'platform',
                signature: `platform:not_listening:${service}:${port}`,
                title: `${service} doesn't listen on port ${port} from outside the container`,
                evidence: evidenceOf(lines.filter((l) => l.service === service).at(-1)),
                fixes: [
                    {
                        id: `fix_listen_address:${service}:${port}`,
                        action: 'fix_listen_address',
                        who: 'dev',
                        label: 'Listen on 0.0.0.0',
                        detail: `The service probably binds to 127.0.0.1. Start it with the host 0.0.0.0 (HOST=0.0.0.0, --host 0.0.0.0) on port ${port}.`,
                    },
                ],
            };
        }
        // The setup waited `after N s` for the app; a longer wait is proposed, up to the most a ready check gets.
        const waited = Number(/after (\d+) s\b/.exec(input.message)?.[1] ?? 0);
        const longer = input.message.includes(CUT_BY_CEILING) ? waited : Math.min(Math.max(waited * 2, 180), MAX_HEALTH_TIMEOUT_SECONDS);
        return {
            kind: 'not_ready',
            signature: input.signature,
            title: input.message.slice(0, 200),
            evidence: evidenceOf(lines.filter((l) => !service || l.service === service).at(-1)),
            fixes: [
                ...(longer > waited ? [raiseHealthTimeout(longer)] : []),
                retry,
            ],
        };
    }

    if (input.signature.startsWith('setup:') && input.kind !== 'unknown') {
        return {
            kind: 'platform',
            signature: input.signature,
            title: input.message.slice(0, 200),
            evidence: evidenceOf({ text: input.message }),
            fixes: [retry],
        };
    }

    // A recipe step the cell ran in the app's container after up (setup, data.migrate, data.seed) failed,
    // and no rule above read its output: the command is the dev's to fix.
    const recipeStep = Object.hasOwn(RECIPE_STEP_SIGNATURES, input.signature) ? RECIPE_STEP_SIGNATURES[input.signature] : undefined;
    if (recipeStep) {
        return {
            kind: input.kind === 'toolchain' ? 'toolchain' : 'seed_data',
            signature: input.signature,
            title: `The recipe's ${recipeStep} failed`,
            evidence: evidenceOf({ text: input.message }),
            fixes: [
                fixRecipe(
                    `Fix ${recipeStep} in .kodus/workspace.yaml on the default branch. A cell runs it in the public service's container once the project is up (a data.seed mapping in the service it names); its output is in the setup's progress.`,
                ),
                retry,
            ],
        };
    }

    // No rule read the logs: keep what the cell said, and show the last log line.
    const known =(KNOWN_KINDS as readonly string[]).includes(input.kind) ? (input.kind as BlockerKindView) : 'unknown';
    return {
        kind: known,
        signature: input.signature,
        title: input.signature === 'compose_up' ? 'The project failed to build or start' : input.message.slice(0, 200) || 'The environment could not boot',
        evidence: evidenceOf(lines.filter((l) => l.service).at(-1) ?? lines.at(-1)),
        fixes: [retry],
    };
}

/** The cell's signatures for a failed recipe boot step (agent runRecipe), by the recipe key it names. */
const RECIPE_STEP_SIGNATURES: Record<string, string> = { recipe_setup: 'setup', recipe_migrate: 'data.migrate', recipe_seed: 'data.seed' };

const KNOWN_KINDS = ['missing_env', 'external_service', 'toolchain', 'native_dep', 'resources', 'seed_data', 'other_repo', 'platform'] as const;
