import type { BlockerInput, ClassifiedBlocker } from '../catalog';
import { type BlockerRule, ENV_NAME, evidenceOf, fixRecipe, largerMachine, type Line, retry } from './rule';

// The rules that read the cause from one log line: the reason first, then the
// bundle's lines newest first. Each is a LineRule; LOG_RULES keeps their order,
// which is also the order matchedBlockerLine reads them in.

/**
 * A test value never looks like a real secret: it names itself. The cell takes
 * exactly these two under a name that looks like a secret (SESSION_SECRET) and
 * refuses any other value there (apps/runtime-cell/internal/recipe/validate.go testValues).
 */
export const testValueFor = (name: string) => (/_URL$|_URI$|_HOST$/.test(name) ? 'http://kodus-fake.invalid' : 'kodus-test-value');

type LineRule = (line: Line) => Omit<ClassifiedBlocker, 'evidence'> | null;

const BELOW_ERROR_LEVELS = new Set(['trace', 'debug', 'info', 'notice', 'warn', 'warning', '10', '20', '30', '40']);

/**
 * A structured log line the app wrote below error level (pino, winston,
 * bunyan JSON: "level":"warn" or 40). It says what the app noticed, not why it
 * stopped: kodus-ai warns "RESEND_API_KEY is not set" on every boot and
 * sends no mail, which a log rule read as the cause of an unrelated crash.
 */
export const belowErrorLevel = (text: string): boolean => {
    const t = text.trimStart();
    if (!t.startsWith('{')) return false;
    const m = /"level"\s*:\s*"?([A-Za-z]+|\d+)"?/.exec(t);
    return m !== null && BELOW_ERROR_LEVELS.has(m[1].toLowerCase());
};

/** apt's package configuration talking ("debconf: (TERM is not set, so the dialog frontend is not usable)"): never a cause. */
const DEBCONF = /\bdebconf: /;

const first = (lines: Line[], rule: LineRule) => {
    // The newest line is the closest to the failure: read from the end.
    for (let i = lines.length - 1; i >= 0; i -= 1) {
        if (belowErrorLevel(lines[i].text) || DEBCONF.test(lines[i].text)) continue;
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

const missingEnv: LineRule = ({ text }) => {
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

// A service that read an env var and refused its value at boot ("X must be
// 32 bytes in hexadecimal"): the value came from the recipe or its compose
// file, so it is the dev's to change, and a new setup fails the same way. A
// generated test value would not fit a format, so the card names the rule
// the app stated instead of offering one.
const INVALID_ENV = /\b([A-Z][A-Z0-9_]{2,63}) (?:must be|should be|is not a valid|is invalid)\b(?! set\b| defined\b)\s*([^\n'"`]{0,80})/;

const invalidEnv: LineRule = ({ text, service }) => {
    const m = INVALID_ENV.exec(text);
    if (!m || !ENV_NAME.test(m[1])) return null;
    const name = m[1];
    const rule = m[2].trim().replace(/[.:;,]+$/, '');
    const who = service ? `The ${service} service` : 'The app';
    return {
        kind: 'missing_env',
        signature: `missing_env:invalid:${name}`,
        title: `${who} refuses the value of ${name}${rule ? `: it must be ${rule}` : ''}`,
        fixes: [
            fixRecipe(
                `Set ${name} to a test value the app accepts${rule ? ` (${rule})` : ''} where the recipe sets it: services.compose.env in .kodus/workspace.yaml, or the compose file it names. Never a real secret. A new setup with the same value fails the same way.`,
            ),
        ],
    };
};

const oom: LineRule = ({ text, service }) =>
    /JavaScript heap out of memory|OOMKilled|exit(?:ed)? (?:with )?(?:code )?137\b|Out of memory: Killed/i.test(text)
        ? {
              kind: 'resources',
              signature: `resources:memory${service ? `:${service}` : ''}`,
              title: `${service ? `The ${service} service` : 'The app'} ran out of memory`,
              fixes: [
                  largerMachine(
                      "In the environment's Machine size, choose Medium (8 GB) or Large (16 GB) and run the setup again. Or lower what it needs: NODE_OPTIONS=--max-old-space-size or a smaller worker count in the compose.",
                  ),
                  fixRecipe(
                      `The cell gives each service the memory it declares (mem_limit, or deploy.resources.limits.memory) and shares the rest of the machine by role: a database or cache gets a small default, the app the rest. Declare mem_limit for ${service ? `the ${service} service` : 'the service'} in the compose file the recipe names, sized to what it needs, or lower what it uses.`,
                  ),
                  retry,
              ],
          }
        : null;

const disk: LineRule = ({ text }) =>
    /no space left on device/i.test(text)
        ? {
              kind: 'resources',
              signature: 'resources:disk',
              title: 'The machine ran out of disk',
              fixes: [retry],
          }
        : null;

const toolchain: LineRule = ({ text }) => {
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

const nativeDep: LineRule = ({ text }) => {
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
const lockfileOutdated: LineRule = ({ text }) => {
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
const GO_NOT_PINNED = " is not pinned by this claim's go.sum";
const GO_VERSION_CHAR = /[0-9A-Za-z.+-]/;
const GO_MODULE_CHAR = /[a-z0-9._~/-]/;

/**
 * `<module>@<version>` right before the go.sum message, read backwards from
 * the literal: at most 65 version and 201 module characters per message, so
 * a long line costs its length and no more (v-core N4: the pattern it
 * replaces tried 200 characters from every offset, about 1 s per bundle).
 */
function goModuleBefore(text: string, at: number): { module: string; version: string } | undefined {
    let i = at;
    while (i > 0 && at - i < 65 && GO_VERSION_CHAR.test(text[i - 1])) i--;
    const version = text.slice(i, at);
    if (!/^v[0-9A-Za-z.+-]{1,64}$/.test(version) || text[i - 1] !== '@') return undefined;
    const end = i - 1;
    let j = end;
    while (j > 0 && end - j < 201 && GO_MODULE_CHAR.test(text[j - 1])) j--;
    // The pattern's own bound: a module name of 2 to 201 characters, from its first letter or digit.
    while (j < end && !/[a-z0-9]/.test(text[j])) j++;
    const module = text.slice(j, end);
    return module.length >= 2 ? { module, version } : undefined;
}

const goModuleNotPinned: LineRule = ({ text }) => {
    const at = text.indexOf(GO_NOT_PINNED);
    if (at < 0) return null;
    const m = goModuleBefore(text, at);
    if (!m) return null;
    return {
        kind: 'toolchain',
        signature: `toolchain:go_module_not_pinned:${m.module}`,
        title: `${m.module}@${m.version} is not in the repository's go.sum`,
        fixes: [
            fixRecipe(
                `Run go mod tidy on the default branch and commit go.sum. The Kodus registry mirror serves only the modules go.sum pins, so a build that needs another one (or runs go get) stops here.`,
            ),
        ],
    };
};

/**
 * BuildKit could not mount the overlay of a long layer chain: the host's overlay
 * takes its lower layers as one mount option of at most a page (4096 bytes), and
 * a Dockerfile of some dozens of layers (one COPY per package.json of a monorepo)
 * outgrows it. The mount error names no layer count, so the line is the cause.
 */
const imageLayers: LineRule = ({ text }) => {
    if (!/mount source: "overlay"/.test(text) || !/fstype: overlay/.test(text) || !/err: invalid argument/.test(text)) return null;
    return {
        kind: 'toolchain',
        signature: 'toolchain:image_layers',
        title: "The Dockerfile makes too many layers for the host's overlay",
        fixes: [
            fixRecipe(
                'Merge COPY and RUN steps so a stage keeps fewer than about 30 layers: copy every package manifest in one COPY (or one COPY of the workspace), install once, then copy the sources in one COPY, and chain related RUN commands with &&. A multi-stage build restarts the count in each stage, so build and runtime stages stay small.',
            ),
        ],
    };
};

const seedData: LineRule = ({ text }) => {
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
const goChecksumDb: LineRule = ({ text }) => {
    if (!/\bsum\.golang\.org\b/.test(text) || !text.includes('verifying ')) return null;
    const m = /verifying (?:module: )?([A-Za-z0-9][A-Za-z0-9._~/-]{1,200})@(v[0-9A-Za-z.+-]{1,64})[^\n]{0,200}sum\.golang\.org/.exec(text);
    if (!m) return null;
    return {
        kind: 'platform',
        signature: 'platform:go_checksum_db',
        title: `The build checks ${m[1]}@${m[2]} against the Go checksum database, which the sandbox does not reach`,
        fixes: [retry],
    };
};

/**
 * A tool's download from the cell's artifact mirror (Prisma engines, the
 * Cypress app, MongoDB, Firebase emulators) answered 404: the mirror serves
 * only the objects its rules name, so this is a rule the cell lacks, never
 * the recipe's. Kodus's gap: no rewrite of the recipe gets past it (a Prisma
 * checksum the mirror refused had Kody rewrite a monorepo's recipe four times).
 */
const mirrorArtifactMissing: LineRule = ({ text }) => {
    const m = /\bmirror\.cell\.internal(?::\d{1,5})?\/artifacts\/([a-z0-9-]{1,40})\/([^\s'"]{1,300})[^\n]{0,120}?\b(?:404|Not Found)\b/.exec(text);
    if (!m) return null;
    const file = m[2].split('/').pop() ?? m[2];
    return {
        kind: 'platform',
        signature: `platform:mirror_artifact_missing:${m[1]}`,
        title: `The cell's ${m[1]} mirror does not serve ${file.slice(0, 120)}, which the build downloads`,
        fixes: [retry],
    };
};

/**
 * firebase-tools downloading an emulator when the emulators start: it has no
 * download-URL setting and goes to storage.googleapis.com, which no machine
 * reaches. The cell's mirror serves the emulators, fetched into the tool's
 * cache before it starts (docs/runtime/egress-allowlist.md, Firebase): Kodus
 * adds that step to the Dockerfiles Kody writes, so the emulators run from
 * one. Kody's recipe for a monorepo dropped the emulators instead, and every
 * Cypress login, which goes through the Auth emulator, would have failed.
 */
const firebaseEmulatorDownload: LineRule = ({ text }) => {
    const m = /storage\.googleapis\.com\/firebase-preview-drop\/emulator\/([A-Za-z0-9._-]{1,120})/.exec(text);
    if (!m) return null;
    return {
        kind: 'toolchain',
        signature: 'toolchain:firebase_emulator_download',
        title: `firebase-tools downloads ${m[1]} from storage.googleapis.com when the emulators start; machines get the emulators only from the Kodus mirror, fetched by a Dockerfile under .kodus/`,
        fixes: [
            fixRecipe(
                'Keep the emulators the tests need and run them from a Dockerfile under .kodus/ (the stage of your Dockerfile that installs firebase-tools and Java): Kodus adds the step that fetches each emulator from its mirror before they start. A Dockerfile of your own needs the same step, described in the Kody Runtime egress documentation (Firebase).',
            ),
        ],
    };
};

// A cell inspects outbound TLS and hands every build step and machine its CA
// in SSL_CERT_FILE and NODE_EXTRA_CA_CERTS (machinetrust, the builder's
// execCABundle). A tool with a trust store of its own ignores both, and its
// download fails the same way on every setup: the Dockerfile has to point it
// at the bundle, so the card never offers a retry.
const CA_UNTRUSTED =
    /UNKNOWN_CERTIFICATE_VERIFICATION_ERROR|UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_GET_ISSUER_CERT_LOCALLY|unable to get local issuer certificate|certificate verify failed|x509: certificate signed by unknown authority/;

const caUntrusted: LineRule = ({ text }) => {
    if (!CA_UNTRUSTED.test(text)) return null;
    const bun = /\bbun (?:install|add|i)\b|\bbunx?\b/.test(text);
    return {
        kind: 'toolchain',
        signature: `toolchain:ca_untrusted:${bun ? 'bun' : 'tool'}`,
        title: `${bun ? 'bun' : 'A tool in the build'} did not trust the certificate of a download`,
        fixes: [
            {
                id: 'trust_cell_ca',
                action: 'fix_recipe',
                who: 'dev',
                label: "Point the tool at the host's certificates",
                detail: `Kody checks what the build downloads and hands each step its certificates in SSL_CERT_FILE and NODE_EXTRA_CA_CERTS. A tool with a trust store of its own needs its CA option pointed at "$SSL_CERT_FILE" in the Dockerfile${bun ? ' (for bun install: --cafile "$SSL_CERT_FILE", or cafile under [install] in a bunfig)' : ''}. Setting it up again without that fails the same way.`,
            },
        ],
    };
};

const unreachable: LineRule = ({ text }) => {
    const m =
        /ECONNREFUSED ([A-Za-z0-9.-]{1,253}):(\d{1,5})|getaddrinfo (?:ENOTFOUND|EAI_AGAIN) ([A-Za-z0-9.-]{1,253})|lookup ([A-Za-z0-9.-]{1,253})(?: on [0-9a-fA-F.:[\]]{1,64})?: no such host|Could not resolve host: ([A-Za-z0-9.-]{1,253})/.exec(
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

/** The log rules in the order they are read, with the id each has in the classifier's registry. */
const LOG_RULES: ReadonlyArray<readonly [id: string, rule: LineRule]> = [
    ['image_layers', imageLayers],
    ['lockfile_outdated', lockfileOutdated],
    ['go_module_not_pinned', goModuleNotPinned],
    ['go_checksum_db', goChecksumDb],
    ['mirror_artifact_missing', mirrorArtifactMissing],
    ['firebase_emulator_download', firebaseEmulatorDownload],
    ['ca_untrusted', caUntrusted],
    ['missing_env', missingEnv],
    ['invalid_env', invalidEnv],
    ['toolchain', toolchain],
    ['native_dep', nativeDep],
    ['oom', oom],
    ['disk', disk],
    ['seed_data', seedData],
    ['unreachable', unreachable],
];

/** The log rules as classifier rules, in their order: each reads every line, newest first, and keeps the line as evidence. */
export const LOG_BLOCKER_RULES: BlockerRule[] = LOG_RULES.map(([id, rule]) => ({
    id: `log:${id}`,
    classify: ({ lines }) => {
        const found = first(lines, rule);
        return found ? { ...found.hit, evidence: evidenceOf(found.line) } : null;
    },
}));

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
    for (const [, rule] of LOG_RULES) {
        if (rule({ text: message })) return message.split(/\r?\n/).find((text) => rule({ text }) !== null);
        const found = first(bundled, rule);
        if (found) return found.line.text;
    }
    return undefined;
}
