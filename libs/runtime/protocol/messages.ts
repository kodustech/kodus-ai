import { z } from 'zod';
import { BrowserExploreRequestSchema, BrowserExploreResultSchema } from '@libs/runtime/contracts/browser-exploration';

import {
    BLOCKER_KINDS,
    BlockerKindSchema as SharedBlockerKindSchema,
    SECURITY_VIOLATION_SIGNATURE,
    CELL_OWNERS,
    CLAIM_CONSUMERS,
    ExposeSchema,
    VM_HEALTH,
} from '@libs/runtime/contracts/enums';
import { AUTHORED_FILES_LIMITS, AuthoredFilesSchema } from '@libs/runtime/contracts/authored-files';
import { MACHINE_SIZE_LIMITS, type MachineSize, MachineSizeSchema } from '@libs/runtime/contracts/machine-size';
import { ExactHostnameSchema } from '@libs/runtime/contracts/boundary-values';
import { CELL_ISOLATIONS, ISOLATION_BACKEND_NAME, MACHINE_ARCHES } from '@libs/runtime/contracts/isolation';
import { MAX_WORKSPACE_REPOSITORIES, REPOSITORY_ALIAS_PATTERN } from '@libs/runtime/contracts/workspace';
import { EVIDENCE_CONTENT_TYPES, EVIDENCE_UPLOAD_TYPES, type EvidenceUploadType } from '@libs/runtime/contracts/evidence';
import { EvidenceRefSchema, ProbeResultSchema, ProbeSchema } from '@libs/runtime/probe';
import { PREVIEW_TUNNEL_TICKET_PATTERN, PREVIEW_TUNNEL_URL_PATTERN, PreviewIdSchema } from '@libs/runtime/contracts/preview';
import { SandboxOpCheckedSchema, SandboxResultSchema } from './sandbox';

// Cell protocol bodies (docs §1b, ADR-051). Every object is strict: an
// unknown or case-variant key is refused, so TS and Go read the same frame.

const id = z.string().min(1).max(128);
const timeoutMs = z.number().int().min(1).max(600_000);
const ms = z.number().int().min(0);
// An exact hostname (lowercase, no port, no scheme). The proxy and the
// resolver compare it byte for byte; a leading "*." is not accepted.
const hostname = ExactHostnameSchema;

const ExposeListSchema = z.array(ExposeSchema).max(64);

// One host of the inspected egress tier (feature egressTiers,
// docs/runtime/egress-allowlist.md §6): an approval made as inspected. The
// cell lets only a GET or HEAD under one of its path prefixes, with no body,
// reach it; the host must also be on the claim's allowlist (egressAllow).
const EgressInspectPath = z.string().min(1).max(256).regex(/^\/[\x21-\x7e]*$/);
export const EgressInspectSchema = z.strictObject({
    host: hostname,
    paths: z.array(EgressInspectPath).min(1).max(16),
});
const EgressInspectListSchema = z.array(EgressInspectSchema).max(256);

// One path segment that is not `.` or `..` (RE2 has no lookahead, and the Go
// cell compiles these patterns, so the exclusion is spelled out).
const SEGMENT = '(?:[A-Za-z0-9_-][A-Za-z0-9_.-]*|\\.[A-Za-z0-9_-][A-Za-z0-9_.-]*|\\.\\.[A-Za-z0-9_.-]+)';
// A file path segment: anything but a separator, a backslash, NUL, `.` or `..`.
const FILE_SEGMENT = '(?:[^/\\\\.\\x00][^/\\\\\\x00]*|\\.[^/\\\\.\\x00][^/\\\\\\x00]*|\\.\\.[^/\\\\\\x00]+)';
/** An upload's path: relative, segments of FILE_SEGMENT (the cell also refuses `.git` and its own `.kodus*`/`.kody*`). */
export const UPLOAD_PATH = new RegExp(`^${FILE_SEGMENT}(/${FILE_SEGMENT})*$`);
// A DNS name whose last label starts with a letter: no IPv4 literal.
const DNS_HOST = '(?:[A-Za-z0-9-]+\\.)*[A-Za-z][A-Za-z0-9-]*';

/**
 * Where the cell downloads the code (ADR-052): the provider's API, never a
 * URL the hub builds. The cell maps (provider, apiBase, fullName, sha) to the
 * provider's tarball route itself and refuses an apiBase it was not
 * configured to reach.
 */
export const RepoRefSchema = z.strictObject({
    provider: z.enum(['github', 'gitlab', 'bitbucket', 'azure_repos', 'forgejo']),
    // owner/repo (or group/subgroup/repo); no `.` or `..` segment, so the
    // cell's tarball route cannot be walked to another API path.
    fullName: z
        .string()
        .min(3)
        .max(512)
        .regex(new RegExp(`^${SEGMENT}(/${SEGMENT})+$`)),
    // https to a DNS name; plain http only to a local name (localhost,
    // 127.0.0.1 or a one-label service name), never to an IP like the
    // metadata address, so the download token never crosses the network in clear.
    apiBase: z
        .string()
        .max(512)
        .regex(new RegExp(`^(https://${DNS_HOST}|http://(localhost|127\\.0\\.0\\.1|[A-Za-z0-9-]+))(:[0-9]{1,5})?(/${SEGMENT})*/?$`)),
});

// claim.acquire size (contracts/machine-size.ts).
export { MACHINE_SIZE_LIMITS, MachineSizeSchema, type MachineSize };
// claim.acquire recipe.files (contracts/authored-files.ts).
export { AUTHORED_FILES_LIMITS, AuthoredFilesSchema };

/**
 * The recipe a claim boots with (claim.acquire recipe), as the worker sends
 * it to the hub and the hub to the cell. `files`: the Dockerfiles and compose
 * files Kody wrote with an authored recipe, which the cell writes under
 * .kodus/ of the checkout before it boots, never over a file the checkout
 * has. Only with a recipe text: a claim whose default branch has no recipe
 * carries no files either.
 */
export const ClaimRecipeSchema = z
    .strictObject({
        path: z.string().min(1).max(256),
        content: z.string().max(65_536).nullable(),
        digest: z.string().max(128).optional(),
        files: AuthoredFilesSchema.optional(),
    })
    .refine((r) => !r.files || r.content !== null, { message: 'authored files come only with a recipe', path: ['files'] });
export type ClaimRecipe = z.infer<typeof ClaimRecipeSchema>;

/**
 * A Run's canaries (ADR-043) as claim.acquire carries them: decoys the cell
 * plants in the workload (config: an env var; npmrc: a credentials file) so
 * code that reads and sends them out shows itself. Never a real secret:
 * HMAC values the worker derives per Run and checks every boundary for (LLM
 * prompt, egress, evidence, publication). The cell keeps them in memory
 * only, never in a label, a log or a frame it sends. Slot seed is checked
 * but not planted by a cell (it needs the app's database).
 */
export const CANARY_SLOTS = ['npmrc', 'config', 'seed'] as const;
export const ClaimCanarySchema = z.strictObject({
    slot: z.enum(CANARY_SLOTS),
    value: z.string().regex(/^[A-Za-z0-9_]{16,64}$/),
});
export type ClaimCanary = z.infer<typeof ClaimCanarySchema>;

/**
 * A Run's drawn identifiers (spec §4 Replay, S-36, ADR-039): the hostname
 * of the workload's services, the seed's user name and the seed's e-mail
 * domain. The worker draws them per Run from the Run's secret
 * (runIdentityOf), the same for both sides, so base and PR stay comparable
 * and a PR cannot hardcode the values its probes will use. The cell sets
 * them in every service's env under RUN_IDENTITY_ENV (a recipe's seed reads
 * them there) and as the hostname of a service that names none. Not a
 * secret, never a label.
 */
export const RUN_IDENTITY_ENV = { hostname: 'KODUS_RUN_HOSTNAME', user: 'KODUS_RUN_USER', domain: 'KODUS_RUN_DOMAIN' } as const;
export const RUN_IDENTITY_HOSTNAME_PATTERN = /^[a-z][a-z0-9-]{1,61}[a-z0-9]$/;
export const RUN_IDENTITY_USER_PATTERN = /^[a-z][a-z0-9_]{2,31}$/;
export const RUN_IDENTITY_DOMAIN_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}(\.[a-z0-9][a-z0-9-]{0,62}){1,4}$/;
export const ClaimRunIdentitySchema = z.strictObject({
    hostname: z.string().regex(RUN_IDENTITY_HOSTNAME_PATTERN),
    user: z.string().regex(RUN_IDENTITY_USER_PATTERN),
    domain: z.string().max(253).regex(RUN_IDENTITY_DOMAIN_PATTERN),
});
export type ClaimRunIdentity = z.infer<typeof ClaimRunIdentitySchema>;

/**
 * One other repository of a multi-repository claim (claim.acquire repos):
 * fetched like `repo`, at its own commit, with a download token for that
 * repository only, into the workspace directory named by its alias.
 */
export const ClaimRepoSchema = z.strictObject({
    alias: z.string().regex(REPOSITORY_ALIAS_PATTERN),
    repo: RepoRefSchema,
    sha: z.string().regex(/^[0-9a-f]{40}$/),
    repoToken: z.string().min(1).max(8_192),
});
export type ClaimRepo = z.infer<typeof ClaimRepoSchema>;

/** Why claim.acquire repos is malformed, or undefined: each alias once (the Go cell's protocol.refine says the same). */
export function claimReposError(repos: readonly { alias: string }[] | undefined): string | undefined {
    const seen = new Set<string>();
    for (const r of repos ?? []) {
        if (seen.has(r.alias)) return `repos: alias ${r.alias} twice`;
        seen.add(r.alias);
    }
    return undefined;
}

/**
 * One org secret as claim.acquire and sandbox.acquire carry it
 * (docs/runtime/sandbox.md "Secrets: OpenBao"): a reference, never the value.
 * id is the secret's key in the store (orgs/<org>/secrets/<id>), name the env
 * var the machines see its placeholder in (id is name in lower case), hosts
 * the exact hosts the injector may send the value to. The cell makes a new
 * placeholder per claim; the value stays in the store and reaches only those
 * hosts, added by the injector on the way out.
 */
export const MAX_CLAIM_SECRETS = 100;
export const MAX_CLAIM_SECRET_HOSTS = 16;

// Text bounds the cell clips its redacted output to (internal/redact).
/** The longest stdout or stderr a step.result exec carries. */
export const STEP_EXEC_OUTPUT_MAX = 16_384;
/** The longest chunk one step.stream carries. */
export const STEP_STREAM_CHUNK_MAX = 65_536;
/** The longest reason a claim.failed carries. */
export const CLAIM_FAILED_REASON_MAX = 4_096;
/** The longest message a blocked carries. */
export const BLOCKED_MESSAGE_MAX = 4_096;
/** The longest log line a failure bundle or a claim.progress carries. */
export const LOG_LINE_MAX = 2_048;

export const ClaimSecretSchema = z.strictObject({
    id: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
    name: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/),
    hosts: z.array(hostname).min(1).max(MAX_CLAIM_SECRET_HOSTS),
});
export type ClaimSecret = z.infer<typeof ClaimSecretSchema>;

/** Why a claim's secrets are malformed, or undefined: each id once, id is the name in lower case (the Go cell's protocol.refine says the same). */
export function claimSecretsError(secrets: readonly { id: string; name: string }[] | undefined): string | undefined {
    const seen = new Set<string>();
    for (const s of secrets ?? []) {
        if (s.name.toLowerCase() !== s.id) return `secrets: ${s.id} is not the lower case of ${s.name}`;
        if (seen.has(s.id)) return `secrets: ${s.id} twice`;
        seen.add(s.id);
    }
    return undefined;
}

/**
 * Optional claim.acquire fields a cell advertises it decodes (hello
 * features). Every field added to claim.acquire after the first cells
 * shipped is one of these: the hub leaves it out for a cell that did not
 * name it.
 *   - seedsCache: claim.acquire seedsCache (a setup seeds the build cache).
 *   - claimSize: claim.acquire size (the environment's machine size).
 *   - egressAllow: claim.acquire egressAllow (the approved hosts as the
 *     claim starts). A cell without it gets them in the egress.policy the
 *     hub pushes after claim.ready, as before the field existed.
 *   - poolMachineSize: pool.target machineSize (pool machines made at the
 *     environment's machine size). A cell without it makes them at its
 *     default size, which no sized claim adopts, so the hub sends a sized
 *     environment's pool to such a cell as size 0.
 *   - authoredFiles: claim.acquire recipe.files (the build files Kody wrote
 *     with its recipe). A recipe that needs them never boots without them:
 *     the hub refuses the claim for a cell that does not name it.
 *   - readyBuildSteps: claim.ready timing.buildSteps (where the boot's image
 *     builds spent their time, step by step). This one goes the other way,
 *     cell to hub: see HUB_ACCEPTED_FEATURES.
 *   - bootPhases: claim.ready timing.phases and claim.failed phases (where
 *     the boot spent its time, in words: the base image pull, each RUN, the
 *     export of the layers, moving the image into Docker, compose up, the
 *     first healthy answer). Cell to hub, like readyBuildSteps; claim.failed
 *     carries the phases of a boot that failed, and claim.progress the
 *     phases so far while it runs (the one still running marked running), so
 *     a boot stopped at its ceiling still says where it was.
 *   - cellMemory: heartbeat memory (what the cell may commit to claims and
 *     what it has committed, builds included). Cell to hub, like
 *     readyBuildSteps: sent only to a hub whose hello ack accepts it. The
 *     hub then admits a claim only when its memory fits (ADR-070); without
 *     it, the hub admits by free slots alone, as before.
 *   - timedRequests, serviceLogs, dbEffects, outboundCalls, execCast: the
 *     evidence a cell captures around a step (EVIDENCE-CAPTURE-DESIGN). Both
 *     ways: the hub sends probe.run/exec `evidence` (what to capture and the
 *     upload grants) only to a cell that named the feature, and the cell
 *     sends the result's field (requests[].at, probe.evidence logs/db/
 *     outbound, exec.refs) only to a hub that accepts it. The verdict never
 *     reads any of them.
 *   - canaries: claim.acquire canaries (the Run's decoys, ADR-043). A cell
 *     without it plants none; the worker still checks every boundary.
 *   - runIdentity: claim.acquire identity (the Run's drawn hostname, seed
 *     user and seed domain). A cell without it gets none, and the hub
 *     reports the claim without it (Claim.identity), so the probes keep the
 *     recipe's own values on both sides.
 *   - browser: the cell plays browser probes in its browser runner (ADR-071).
 *     Both ways: the hub sends the browser capture, its upload grants and
 *     the baseline screenshots only to a cell that names it, and the cell
 *     sends probe.browser (steps, pixel diffs, network, console) only to a
 *     hub that accepts it. A cell without it refuses a browser probe with
 *     browser_unavailable, as before the runner existed.
 *   - workspace: claim.acquire repos (the other repositories of a
 *     multi-repository environment, each fetched with its own token into
 *     its own directory) and exec.repository (a command on one of them).
 *     The hub sends either only to a cell that names it; a cell that does
 *     not refuses a recipe with services.needs.
 *   - sandbox: the cell boots sandbox.acquire (one tool container under its
 *     isolation, no compose, no Run) and runs sandbox.op through the guest
 *     agent inside it. The hub sends either only to a cell that names it.
 *   - traceContext: the envelope's traceparent (W3C trace context). The
 *     hub sends it on a claim's frames, from the span that sends them, so the
 *     cell's spans join the Run's trace; the cell passes it on to its guest
 *     agent. A cell without it gets no traceparent.
 *   - readyStart: claim.ready start (whether the claim's workload came
 *     cold, from a pool machine or from a bake this cell made). Cell to hub,
 *     like readyBuildSteps: sent only to a hub whose hello ack accepts it.
 *   - secrets: claim.acquire and sandbox.acquire secrets (the org's secrets
 *     by reference). The cell gives each a placeholder per claim in the
 *     machines' env and signs it into the claim's egress policy, so the
 *     injector swaps it for the value on its hosts. A cell without it gets
 *     none, and its machines hold no placeholder.
 *   - egressTiers: claim.acquire and sandbox.acquire egressInspect and
 *     egressRecommended, and egress.policy inspect
 *     (docs/runtime/egress-allowlist.md): the approvals made as inspected,
 *     and whether the org keeps the Kodus recommended list on. A cell
 *     without it gets the hosts in egressAllow alone (an inspected approval
 *     reaches it as a plain one) and has no recommended list to turn off.
 *   - preview: claim.acquire consumer preview, and preview.tunnel,
 *     preview.route and preview.unroute (docs/runtime/preview-urls.md §9.1).
 *     The hub sends a cell without it no preview claim.
 *   - buildStateEvicted: heartbeat evictedBuildStates (the environments
 *     whose build state the cell's disk floor removed and no setup of their
 *     default branch made again: their builds run with no cache until one
 *     does). Cell to hub, like readyBuildSteps: sent only to a hub whose
 *     hello ack accepts it. The list is the cell's whole ledger each time:
 *     from a cell that named the feature, a heartbeat without it has none.
 *   - buildStateRebuildCost: heartbeat evictedBuildStates[].rebuildSeconds,
 *     how long the build that made each evicted state from none took (the
 *     cost of the next build that finds it gone with no cache). Cell to hub:
 *     sent only to a hub whose hello ack accepts it.
 *   - cellProtocols: hello ack cellProtocols, the cell protocol versions the
 *     hub accepts at hello (MIN_CELL_PROTOCOL_VERSION to PROTOCOL_VERSION,
 *     the skew policy in envelope.ts). The cell keeps it on its host, so
 *     `cell update` refuses a release this hub would refuse at hello
 *     (docs/runtime/cell-distribution.md). A cell without it gets the ack
 *     it always got.
 */
export const CELL_FEATURES = [
    'seedsCache',
    'claimSize',
    'egressAllow',
    'poolMachineSize',
    'authoredFiles',
    'readyBuildSteps',
    'bootPhases',
    'cellMemory',
    'timedRequests',
    'serviceLogs',
    'dbEffects',
    'outboundCalls',
    'execCast',
    'browser',
    'canaries',
    'browserExplore',
    'recipeFakes',
    'seededSQL',
    'workspace',
    'sandbox',
    'secrets',
    'readyStart',
    'traceContext',
    'preview',
    'buildStateEvicted',
    'egressTiers',
    'snapshots',
    // snapshot.forget: the hub has the cell remove an org's sessions (a PR
    // closed, docs/runtime/isolation-p3-snapshots.md). An older cell keeps
    // them to SessionTTL; the hub sends it the frame only when named.
    'snapshotForget',
    // heartbeat host: the KVM host's SMT, KSM, swap, unmitigated CPU
    // vulnerabilities and microcode, and the cell's host policy (shared
    // cells refuse an unsafe host; dedicated ones start and report it). Cell
    // to hub, like readyBuildSteps: sent only to a hub whose hello ack
    // accepts it.
    'hostHardening',
    'buildStateRebuildCost',
    'runIdentity',
    'cellProtocols',
    // claim.exercised and step.result exercised: after the probes, the cell
    // counts which of the PR's changed lines its Node services ran
    // (EXERCISED_LINES_LIMITS). The hub sends the frame only to a cell that
    // names it. The 33rd name: a cell names it only while its hello stays
    // within HELLO_FEATURES_OLDER_HUB_MAX, so a hub older than the 64 still
    // accepts the hello.
    'exercisedLines',
    // Shared baked environments (docs/runtime/shared-baked-environments.md):
    // the cell pushes each image of its bakes to the org's registry and pulls
    // another cell's by digest. Both ways: the hub sends claim.acquire
    // sharedImages only to a cell that names it, and the cell sends
    // image.shared only to a hub that accepts it. Like exercisedLines, a cell
    // names it only while its hello stays within HELLO_FEATURES_OLDER_HUB_MAX.
    'bakeShare',
] as const;
export type CellFeature = (typeof CELL_FEATURES)[number];

/**
 * The most features a hub before the 64 limit accepts in a hello. After such
 * a hub refuses a longer hello, the cell's next one keeps only the oldest
 * features it names, at most this many (agent.go trimForOlderHub), until
 * every hub accepts 64. So a new feature always goes at the end of
 * CELL_FEATURES: the trim drops from the end.
 */
export const HELLO_FEATURES_OLDER_HUB_MAX = 32;

/**
 * claim.exercised (feature exercisedLines): which of the PR's changed lines
 * the PR side ran during the probes. The worker names the changed executable
 * lines (repository-relative paths, new-side line numbers); the cell answers
 * line counts per file and never the coverage itself, which stays in the
 * claim.
 */
export const EXERCISED_LINES_LIMITS = { files: 200, linesPerFile: 2_000, maxLine: 1_000_000 } as const;
export const EXERCISED_LANGUAGES = ['node', 'unsupported'] as const;
export const EXERCISED_FILE_STATUSES = ['measured', 'unknown'] as const;
/**
 * Why a file is unknown:
 *   - no_coverage_written: no service of the claim wrote coverage.
 *   - not_loaded_unproven: no script or source map maps to the file, and no
 *     other file of the claim mapped (nothing proves the mapping works).
 *   - unmapped_source: a script maps to the file but its coverage could not
 *     be read back to its lines (a source map that does not decode).
 *   - unsupported_language: not a JS or TS file.
 *   - unsupported_driver: the claim's driver cannot collect coverage.
 *   - coverage_too_large: the coverage the claim wrote is past the cell's bound.
 */
export const EXERCISED_UNKNOWN_REASONS = ['no_coverage_written', 'not_loaded_unproven', 'unmapped_source', 'unsupported_language', 'unsupported_driver', 'coverage_too_large'] as const;
const exercisedPath = z.string().min(1).max(1_024).regex(UPLOAD_PATH);
const exercisedCount = z.number().int().min(0).max(EXERCISED_LINES_LIMITS.linesPerFile);
export const ExercisedRequestSchema = z.strictObject({
    files: z
        .array(
            z.strictObject({
                path: exercisedPath,
                lines: z.array(z.number().int().min(1).max(EXERCISED_LINES_LIMITS.maxLine)).min(1).max(EXERCISED_LINES_LIMITS.linesPerFile),
            }),
        )
        .min(1)
        .max(EXERCISED_LINES_LIMITS.files),
});
export type ExercisedRequest = z.infer<typeof ExercisedRequestSchema>;
export const ExercisedResultSchema = z.strictObject({
    language: z.enum(EXERCISED_LANGUAGES),
    files: z
        .array(
            z.strictObject({
                path: exercisedPath,
                changedLines: exercisedCount,
                exercisedLines: exercisedCount.nullable(),
                status: z.enum(EXERCISED_FILE_STATUSES),
                reason: z.enum(EXERCISED_UNKNOWN_REASONS).optional(),
            }),
        )
        .max(EXERCISED_LINES_LIMITS.files),
});
export type ExercisedResult = z.infer<typeof ExercisedResultSchema>;

/**
 * The optional fields a cell may send that a hub older than them refuses
 * (its decoder is strict). A cell names the feature in hello; a hub that
 * accepts the field echoes the name in the hello ack's `accepts`, and only
 * then does the cell send it. An older hub ignores the unknown name and acks
 * without `accepts`, so it never sees the field; an older cell never names
 * it, so it never gets an ack with `accepts` it would refuse.
 */
export const HUB_ACCEPTED_FEATURES = ['readyBuildSteps', 'bootPhases', 'cellMemory', 'timedRequests', 'serviceLogs', 'dbEffects', 'outboundCalls', 'execCast', 'browser', 'browserExplore', 'readyStart', 'buildStateEvicted', 'snapshots', 'hostHardening', 'buildStateRebuildCost', 'bakeShare'] as const satisfies readonly CellFeature[];
export type HubAcceptedFeature = (typeof HUB_ACCEPTED_FEATURES)[number];

/** What a hello ack's `accepts` names: the cell's features this hub accepts fields of. Empty: send `accepts` not at all. */
export function hubAccepts(cellFeatures: readonly string[] | undefined): HubAcceptedFeature[] {
    return HUB_ACCEPTED_FEATURES.filter((f) => cellFeatures?.includes(f));
}

/** claim.ready start: how a claim's workload came to be. template and session only to a hub that accepts snapshots. */
export const CLAIM_STARTS = ['cold', 'pool', 'bake', 'template', 'session'] as const;
export type ClaimStart = (typeof CLAIM_STARTS)[number];

/**
 * Memory snapshots of a microVM (feature snapshots,
 * docs/runtime/isolation-p3-snapshots.md):
 *   - template: a setup's machine that ran no PR code and was handed no
 *     secret; many machines of its org start from it; its source ends.
 *   - session: one machine set aside, restored once.
 *   - round: a claim's own machine at its first ready state, restored on
 *     each machine.reset of that claim, deleted with it; never a template.
 */
export const SNAPSHOT_PURPOSES = ['template', 'session', 'round'] as const;
export type SnapshotPurpose = (typeof SNAPSHOT_PURPOSES)[number];
/** A snapshot's id: random, made by the cell. */
export const SnapshotIdSchema = z.string().regex(/^ksn-[0-9a-f]{32}$/);
/** What a template is kept under for its org (a repository, a tool set): the newest one of a key replaces the others. */
export const SnapshotKeySchema = z.string().regex(/^[a-z0-9][a-z0-9._:-]{0,127}$/);

/** Why a sandbox.acquire's snapshot fields do not go together, or undefined (the Go cell's refine says the same). */
export function sandboxSnapshotError(b: { prepares?: boolean; templateKey?: string; resumeFrom?: string; secrets?: unknown[] }): string | undefined {
    if (b.prepares && !b.templateKey) return 'a sandbox that prepares a template names its templateKey';
    if (b.prepares && b.secrets?.length) return 'a sandbox that prepares a template is handed no secret';
    if (b.resumeFrom && (b.prepares || b.templateKey)) return 'a sandbox resumes a session or starts from a template, not both';
    return undefined;
}

const CellFeatureNameSchema = z.string().regex(/^[a-z][A-Za-z0-9]{0,63}$/);

/** The features of a hello this hub knows, once each; a name it does not know is a newer cell's, ignored. */
export function knownCellFeatures(names: readonly string[] | undefined): CellFeature[] {
    return CELL_FEATURES.filter((f) => names?.includes(f));
}

/**
 * claim.ready timing.buildSteps: where the boot's image builds spent their
 * time, as BuildKit measured each step. Counts over every build of the boot,
 * and its slowest steps that ran (not cached), slowest first. A step's name
 * is its Dockerfile line, redacted by the cell and cut to 160 bytes; no
 * output of a step is ever sent.
 */
const stepCount = z.number().int().min(0).max(100_000);
export const BuildStepsSchema = z.strictObject({
    steps: stepCount,
    done: stepCount,
    cached: stepCount,
    errored: stepCount,
    slowest: z
        .array(z.strictObject({ service: z.string().min(1).max(128), name: z.string().min(1).max(160), ms }))
        .max(8),
});
export type BuildSteps = z.infer<typeof BuildStepsSchema>;

/**
 * claim.ready timing.phases and claim.failed phases: where the boot spent its
 * time, in words a person reads at a glance ("yarn install", "export layers",
 * "pull image", "compose up", "first healthy"), slowest first, at most 8.
 * Phases of the same name across services are added up. A name comes from a
 * Dockerfile line the cell already redacted, cut to 48 bytes. running: the
 * phase had not ended when the boot stopped (claim.failed only).
 */
export const BootPhasesSchema = z
    .array(z.strictObject({ name: z.string().min(1).max(48), ms, running: z.literal(true).optional() }))
    .max(8);
export type BootPhases = z.infer<typeof BootPhasesSchema>;

/**
 * One upload grant (EVIDENCE-CAPTURE-DESIGN "Transport and storage"): where
 * the cell PUTs one artifact, with which content type and at most how many
 * bytes, until when. The URL carries the worker's signature over all of it;
 * https to a DNS name, or plain http to a local name only (never an IP
 * literal, so a grant cannot point the cell at a metadata address).
 */
export const UploadGrantSchema = z.strictObject({
    type: z.enum(EVIDENCE_UPLOAD_TYPES),
    url: z
        .string()
        .max(4_096)
        .regex(new RegExp(`^(https://${DNS_HOST}|http://(localhost|127\\.0\\.0\\.1|[A-Za-z0-9-]+))(:[0-9]{1,5})?/[A-Za-z0-9_./-]*\\?[A-Za-z0-9_=&%.-]*$`)),
    contentType: z.enum(EVIDENCE_CONTENT_TYPES),
    maxBytes: z.number().int().min(1).max(20 * 1_024 * 1_024),
    expiresAt: z.iso.datetime(),
});
export type UploadGrantBody = z.infer<typeof UploadGrantSchema>;

/** What a step asks the cell to capture around it; each is one hello feature (EVIDENCE_CAPTURE_FEATURE). */
export const EVIDENCE_CAPTURES = ['logs', 'db', 'outbound', 'cast', 'browser'] as const;
export type EvidenceCapture = (typeof EVIDENCE_CAPTURES)[number];

export const EVIDENCE_CAPTURE_FEATURE: Record<EvidenceCapture, CellFeature> = {
    logs: 'serviceLogs',
    db: 'dbEffects',
    outbound: 'outboundCalls',
    cast: 'execCast',
    browser: 'browser',
};

/** The capture an upload type belongs to: the browser runner's artifacts (screenshots, video, trace, HAR, pixel diffs) are `browser`. */
export function captureOfUpload(type: EvidenceUploadType): EvidenceCapture {
    if (type === 'logs' || type === 'db' || type === 'cast') return type;
    return 'browser';
}

/** The feature a cell must name to be sent a grant of this type. */
export function uploadFeatureOf(type: EvidenceUploadType): CellFeature {
    return EVIDENCE_CAPTURE_FEATURE[captureOfUpload(type)];
}

/**
 * One screenshot of the baseline round (main's first healthy round of a
 * browser probe): the step that took it, its N in screenshot-N, and a read
 * URL the worker signed for that exact object, under the same host rule as
 * an upload grant. The cell diffs the screenshot its own round took at the
 * same step against it, never another step's.
 */
export const BaselineScreenshotSchema = z.strictObject({
    step: z.number().int().min(0).max(99),
    screenshot: z.number().int().min(0).max(9),
    url: UploadGrantSchema.shape.url,
});
export type BaselineScreenshot = z.infer<typeof BaselineScreenshotSchema>;

export const EvidenceRequestSchema = z.strictObject({
    capture: z.array(z.enum(EVIDENCE_CAPTURES)).max(EVIDENCE_CAPTURES.length),
    uploads: z.array(UploadGrantSchema).max(32).optional(),
    // browser: the baseline round's screenshots to diff against; absent on the baseline round itself.
    baseline: z.array(BaselineScreenshotSchema).max(10).optional(),
});
export type EvidenceRequest = z.infer<typeof EvidenceRequestSchema>;

/**
 * The part of a step's evidence request a cell with these features decodes
 * and can do; undefined when nothing is left (the field is then not sent).
 */
export function evidenceRequestFor(features: readonly string[] | undefined, req: EvidenceRequest | undefined): EvidenceRequest | undefined {
    if (!req) return undefined;
    const has = (f: CellFeature | undefined) => !!f && !!features?.includes(f);
    const capture = [...new Set(req.capture)].filter((c) => has(EVIDENCE_CAPTURE_FEATURE[c]));
    const uploads = (req.uploads ?? []).filter((u) => has(uploadFeatureOf(u.type)) && capture.includes(captureOfUpload(u.type)));
    const baseline = capture.includes('browser') ? (req.baseline ?? []) : [];
    if (capture.length === 0) return undefined;
    return { capture, ...(uploads.length ? { uploads } : {}), ...(baseline.length ? { baseline } : {}) };
}

export const BlockerKindSchema = SharedBlockerKindSchema;
export { BLOCKER_KINDS };

/**
 * What the cell collects when a setup claim fails (§11 runbook "Setup falha e
 * o Blocker não explica"), redacted like any other output (S-51). The cell
 * keeps it under the frame limit by dropping the oldest log lines first.
 */
export const FailureBundleSchema = z.strictObject({
    services: z
        .array(
            z.strictObject({
                name: z.string().min(1).max(128),
                state: z.string().max(128),
                logTail: z.array(z.string().max(LOG_LINE_MAX)).max(500),
            }),
        )
        .max(32),
    ports: z
        .array(
            z.strictObject({
                service: z.string().min(1).max(128),
                port: z.number().int().min(1).max(65_535),
                listening: z.boolean(),
            }),
        )
        .max(64),
    disk: z.array(z.strictObject({ path: z.string().min(1).max(256), totalBytes: z.number().int().min(0), freeBytes: z.number().int().min(0) })).max(8),
    deniedEgress: z
        .array(
            z.strictObject({
                host: z.string().max(256),
                port: z.number().int().min(1).max(65_535),
                at: z.iso.datetime(),
                // The platform deny list refused it (cloud storage, paste sites): no approval lifts it.
                platform: z.boolean().optional(),
            }),
        )
        .max(100),
    redactions: z.number().int().min(0),
    truncated: z.boolean(),
    collectedAt: z.iso.datetime(),
});

export type FailureBundle = z.infer<typeof FailureBundleSchema>;

/** The most memory a heartbeat may name, in MB (1 TiB): bounds every field of heartbeat memory. */
export const MAX_CELL_MEMORY_MB = 1_048_576;
const memoryMb = z.number().int().min(0).max(MAX_CELL_MEMORY_MB);

/**
 * heartbeat memory (ADR-070), in MB: what the cell may commit to claims (its
 * host memory less its reserve), what it has committed (every claim it
 * holds: a booting claim at its build size, a ready one at its ready size),
 * and the two sizes a claim that asks no machine size is counted at. A
 * sized claim is counted at its size while it boots, and at the smaller of
 * its size and readyMb once ready.
 */
export const HeartbeatMemorySchema = z.strictObject({
    allocatableMb: memoryMb,
    committedMb: memoryMb,
    bootMb: memoryMb,
    readyMb: memoryMb,
});
export type HeartbeatMemory = z.infer<typeof HeartbeatMemorySchema>;

/** The most environments one heartbeat names in evictedBuildStates (the cell's ledger keeps as many). */
export const MAX_EVICTED_BUILD_STATES = 64;

/**
 * heartbeat evictedBuildStates: one environment whose build state the cell's
 * disk floor removed (evictedAt) and no setup of its default branch made
 * again. Ids only.
 */
export const EvictedBuildStateSchema = z.strictObject({
    orgId: id,
    environmentId: id,
    evictedAt: z.iso.datetime(),
    // Only to a hub whose hello ack accepts buildStateRebuildCost: how long the
    // build that made the state from none took, in seconds (at most a week);
    // absent when the cell never measured it.
    rebuildSeconds: z.number().int().min(1).max(604_800).optional(),
});
export type EvictedBuildState = z.infer<typeof EvictedBuildStateSchema>;
const hostSwitch = z.enum(['on', 'off', 'unknown']);
/** What a microVM cell found of its host (cell feature hostHardening). */
export const HeartbeatHostSchema = z.strictObject({
    policy: z.enum(['shared', 'dedicated']),
    smt: hostSwitch,
    ksm: hostSwitch,
    swap: hostSwitch,
    vulnerable: z.array(z.string().regex(/^[a-z0-9_]{1,64}$/)).max(32),
    microcode: z.string().max(32).optional(),
});
export type HeartbeatHost = z.infer<typeof HeartbeatHostSchema>;

/**
 * hello capabilities (docs/runtime/isolation-architecture.md C2): what the
 * cell's machines can be, beside the isolation it runs claims under.
 *   - backends: the isolation backends the cell runs ("gvisor", later
 *     "firecracker"), plain names an older hub ignores.
 *   - snapshotMemory: a machine's memory can be snapshotted and restored.
 *   - nestedDocker: a workload can run containers (compose) in its machine.
 *   - kvm: the cell's host gives it /dev/kvm.
 *   - arch: the architecture its machines run.
 *   - maxSize: the largest size it grants one claim (hello maxClaimSize).
 *   - defaultSize: the size a claim that asks none runs at; a fractional
 *     default CPU count is announced by its whole part, as maxSize is. The
 *     hub records its vCPUs on such a claim (the usage report's vCPU·min).
 *   - sandboxSize: the size a code sandbox that asks none runs at and is
 *     counted at (its blank pool sandboxes are of it), within maxSize; absent
 *     from a cell that runs no sandboxes or is older than it. The hub admits
 *     such a sandbox at it, never at defaultSize (a Run's).
 * Placement reads hello isolation; these say what a cell could offer next.
 */
export const HelloCapabilitiesSchema = z.strictObject({
    backends: z.array(z.string().regex(ISOLATION_BACKEND_NAME)).max(8),
    snapshotMemory: z.boolean(),
    nestedDocker: z.boolean(),
    kvm: z.boolean(),
    arch: z.enum(MACHINE_ARCHES),
    maxSize: MachineSizeSchema.optional(),
    defaultSize: MachineSizeSchema.optional(),
    sandboxSize: MachineSizeSchema.optional(),
});
export type HelloCapabilities = z.infer<typeof HelloCapabilitiesSchema>;

/**
 * One service image of a bake, as the cell pushed it to the org's registry
 * (feature bakeShare): the build fingerprint a claim matches it by and the
 * image manifest's digest, the only name a cell pulls it by.
 */
export const SharedImageSchema = z.strictObject({
    fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
});
export type SharedImage = z.infer<typeof SharedImageSchema>;
/** The most images one bake shares, and one claim.acquire names (a bake keeps at most 128 per generation; a recipe far fewer services). */
export const MAX_SHARED_IMAGES = 64;

export const MessageBodySchemas = {
    'hello': z.strictObject({
        versions: z.array(z.number().int().min(1)).min(1).max(16),
        driver: z.string().min(1).max(64),
        // 'none' is the dev-only local-docker driver; a hub refuses it unless
        // it runs with RUNTIME_DEV_ALLOW_INSECURE_CELLS=1.
        isolation: z.enum(CELL_ISOLATIONS),
        regions: z.array(z.string().max(64)).max(64),
        owner: z.enum(CELL_OWNERS),
        // The optional claim.acquire fields this cell decodes (CELL_FEATURES).
        // The hub sends a cell only the fields it named, so a newer hub never
        // breaks an older cell's strict decoder. Absent: none. Plain names,
        // not an enum, so a newer cell's feature an older hub does not know
        // is ignored by that hub instead of refusing the hello.
        // 64, not 32: CELL_FEATURES reached 32, and a hub must accept a longer
        // list before any cell sends one (the skew policy: hub first).
        features: z.array(CellFeatureNameSchema).max(64).optional(),
        // The largest size the cell grants one claim (its driver's maximum,
        // clamped to MACHINE_SIZE_LIMITS: no claim asks more). Absent: it
        // grants none, and the hub sends it no sized claim.
        maxClaimSize: MachineSizeSchema.optional(),
        // What the cell's machines can be (HelloCapabilitiesSchema). Absent: a
        // cell older than it; the hub places it by isolation alone.
        capabilities: HelloCapabilitiesSchema.optional(),
    }),
    'heartbeat': z.strictObject({
        claims: z.array(z.strictObject({ claimId: id, machines: z.number().int().min(0) })).max(1_024),
        freeSlots: z.number().int().min(0),
        // Only to a hub whose hello ack accepts cellMemory (ADR-070).
        memory: HeartbeatMemorySchema.optional(),
        // Only to a hub whose hello ack accepts buildStateEvicted: the cell's whole ledger, newest first.
        evictedBuildStates: z.array(EvictedBuildStateSchema).max(MAX_EVICTED_BUILD_STATES).optional(),
        // Only to a hub whose hello ack accepts hostHardening.
        host: HeartbeatHostSchema.optional(),
    }),
    'claim.acquire': z.strictObject({
        orgId: id,
        environmentId: id,
        // The Run the claim serves, for the cell's per-claim logs only.
        runId: id.optional(),
        imageId: id,
        side: z.enum(['base', 'pr', 'setup']),
        sha: z.string().regex(/^[0-9a-f]{40}$/),
        consumer: z.enum(CLAIM_CONSUMERS),
        repo: RepoRefSchema,
        // Download token for this repo only, 1 h, contents:read (ADR-002, ADR-052).
        repoToken: z.string().min(1).max(8_192),
        expose: ExposeListSchema,
        hardExpiresAt: z.iso.datetime(),
        // The lease the hub keeps for this claim (LEASE_TTL_MINUTES of its
        // consumer): the machines' first kodus:expires, so a boot longer than
        // the cell's own initial lease is not swept while it runs. Never past
        // hardExpiresAt; absent, the cell's initial lease applies.
        leaseExpiresAt: z.iso.datetime().optional(),
        // Keep the machines of a failed setup until hardExpiresAt for the
        // dev's agent to investigate (no verdict probes). Only a setup claim
        // that is not a PR may ask; the cell refuses it on any other claim.
        diagnosticHold: z.boolean().optional(),
        // A setup of the default branch: each build's cache becomes the
        // environment's as soon as the build finishes, not only at a bake, so
        // a setup that fails later (boot, health, its ceiling) leaves the next
        // one its layers. Only a setup claim that is not a PR may ask.
        seedsCache: z.boolean().optional(),
        // The recipe the product read from the default branch (§6). The cell
        // boots with it, never with the checkout's copy (a PR could change
        // that one); content null: the default branch has none, so the
        // checkout's copy is removed. Absent: the cell reads the checkout.
        recipe: ClaimRecipeSchema.optional(),
        // The environment's approved outbound hosts (ADR-034) as the claim
        // starts: the policy the cell pushes before the build already has
        // them. An egress.policy later replaces the list, as on any claim.
        egressAllow: z.array(hostname).max(256).optional(),
        // Feature egressTiers: the approvals made as inspected (each host is
        // also in egressAllow), and false when the org turned the Kodus
        // recommended list off. Absent: no inspected approval, list on.
        egressInspect: EgressInspectListSchema.optional(),
        egressRecommended: z.boolean().optional(),
        // The environment's machine size for this claim's workload: the
        // memory and CPUs every build and service gets. The cell refuses a
        // size above the largest it grants (blocker resources/size_unavailable)
        // before it creates anything. Absent: the cell's default size.
        size: MachineSizeSchema.optional(),
        // The Run's canaries (ADR-043), one per slot at most: the cell
        // plants them in the workload (env and a credentials file), never
        // in a label, a log or anything it sends back.
        canaries: z.array(ClaimCanarySchema).max(CANARY_SLOTS.length).optional(),
        // The Run's drawn identifiers (feature runIdentity), the same on
        // both sides: every service's env (RUN_IDENTITY_ENV) and the hostname
        // of a service that names none. A cell ignores it on a setup claim.
        identity: ClaimRunIdentitySchema.optional(),
        // The other repositories of a multi-repository environment (feature
        // workspace), the claim's own repository being `repo`. Absent for an
        // environment of one repository.
        repos: z.array(ClaimRepoSchema).min(1).max(MAX_WORKSPACE_REPOSITORIES - 1).optional(),
        // The org's secrets by reference (feature secrets): the cell gives
        // each a placeholder in the machines' env, the injector swaps it for
        // the value on the secret's hosts. Never the PR side of a fork.
        secrets: z.array(ClaimSecretSchema).min(1).max(MAX_CLAIM_SECRETS).optional(),
        // Feature bakeShare: the environment's images another cell of the org
        // baked and pushed, by fingerprint and digest. The cell pulls one by
        // digest for a build whose fingerprint matches and that it holds no
        // image of, and builds as before on any failure. Never on a setup.
        sharedImages: z.array(SharedImageSchema).min(1).max(MAX_SHARED_IMAGES).optional(),
    }).refine((b) => claimSecretsError(b.secrets) === undefined, {
        message: 'each secret once, its id the lower case of its name',
        path: ['secrets'],
    }).refine((b) => !b.diagnosticHold || b.consumer === 'setup', {
        message: 'only a setup claim may ask for a diagnostic hold',
        path: ['diagnosticHold'],
    }).refine((b) => !b.seedsCache || (b.consumer === 'setup' && b.side !== 'pr'), {
        message: 'only a setup claim that is not a PR may seed the build cache',
        path: ['seedsCache'],
    }).refine((b) => claimReposError(b.repos) === undefined, {
        message: 'each repository of a claim has its own alias',
        path: ['repos'],
    }),
    // A code sandbox (feature sandbox): the claim's network and one tool
    // container with an empty /workspace, under the claim's lease and
    // ceiling, no compose, no observer, no Run. Answered like claim.acquire:
    // ack, then claim.ready or claim.failed. The code comes in through
    // sandbox.op (a git fetch the caller runs), never from the cell.
    'sandbox.acquire': z.strictObject({
        orgId: id,
        hardExpiresAt: z.iso.datetime(),
        leaseExpiresAt: z.iso.datetime().optional(),
        // The hosts it may reach (the ones approved for sandboxes and the git
        // host the caller fetches from), on top of the cell's base list; never
        // an environment's approvals (G5).
        egressAllow: z.array(hostname).max(256).optional(),
        // Feature egressTiers, as in claim.acquire.
        egressInspect: EgressInspectListSchema.optional(),
        egressRecommended: z.boolean().optional(),
        size: MachineSizeSchema.optional(),
        // The org's secrets by reference (feature secrets), as in claim.acquire.
        secrets: z.array(ClaimSecretSchema).min(1).max(MAX_CLAIM_SECRETS).optional(),
        // Feature snapshots. prepares: this sandbox makes its org's template
        // under templateKey (claim.snapshot template); the caller runs in it
        // only what a setup runs (no PR code), and it is handed no secret.
        // templateKey without prepares: start from the org's newest template
        // of that key when the cell holds one, else boot as usual (claim.ready
        // start says which). resumeFrom: a session snapshot of the org,
        // restored once.
        prepares: z.boolean().optional(),
        templateKey: SnapshotKeySchema.optional(),
        resumeFrom: SnapshotIdSchema.optional(),
    }).refine((b) => claimSecretsError(b.secrets) === undefined, {
        message: 'each secret once, its id the lower case of its name',
        path: ['secrets'],
    }).refine((b) => sandboxSnapshotError(b) === undefined, {
        message: 'prepares needs a templateKey and no secrets; resumeFrom goes with neither',
        path: ['prepares'],
    }),
    // The claim's machines are up, the code is in and the observer answers.
    // The hub only marks a claim bound on this message, never on the ack of
    // claim.acquire (which only means "accepted, working on it").
    'claim.ready': z.strictObject({
        manifest: z.strictObject({
            services: z.array(z.strictObject({ name: z.string().min(1).max(128), health: z.enum(['ok', 'failed']) })).max(64),
            expose: ExposeListSchema,
            imageId: id,
            seedSha: z.string().min(1).max(128),
        }),
        observer: z.strictObject({ id, state: z.enum(['creating', 'ready', 'failed']) }),
        // How the workload came to be (CLAIM_STARTS): built and booted (cold), a ready
        // pool machine adopted (pool), or a base booted from a bake this cell made
        // (bake). Only to a hub whose hello ack accepts readyStart.
        start: z.enum(CLAIM_STARTS).optional(),
        // How long the claim took on the cell, in ms. prepareMs is the cell
        // agent's wall time from the ack of claim.acquire to this message
        // (network, machines, code, boot, egress); the rest are the driver's
        // boot phases when it measures them (local-docker BootReport: build =
        // setup + pull/build, up = up --wait, seed = migrate + seed, ready =
        // the recipe's health check, snapshot = copying the data volumes after
        // the first ready boot (data.reset: snapshot), boot = their sum).
        timing: z
            .strictObject({
                prepareMs: ms,
                bootMs: ms.optional(),
                buildMs: ms.optional(),
                upMs: ms.optional(),
                seedMs: ms.optional(),
                readyMs: ms.optional(),
                snapshotMs: ms.optional(),
                // Only to a hub whose hello ack accepts readyBuildSteps.
                buildSteps: BuildStepsSchema.optional(),
                // Only to a hub whose hello ack accepts bootPhases.
                phases: BootPhasesSchema.optional(),
            })
            .optional(),
    }),
    // The claim will never be ready; the cell has already cleaned it up.
    // With held: true the cell kept the machines for a diagnostic hold until
    // hardExpiresAt (only exec and claim.release are accepted on the claim).
    'claim.failed': z.strictObject({
        kind: BlockerKindSchema,
        signature: z.string().min(1).max(256),
        reason: z.string().max(CLAIM_FAILED_REASON_MAX),
        bundle: FailureBundleSchema.optional(),
        held: z.boolean().optional(),
        // Where the boot spent its time until it stopped; only to a hub whose
        // hello ack accepts bootPhases.
        phases: BootPhasesSchema.optional(),
    }),
    'claim.renew': z.strictObject({ leaseExpiresAt: z.iso.datetime() }),
    'claim.release': z.strictObject({}),
    // evidence: only to a cell whose hello names the feature of each capture (evidenceRequestFor).
    'browser.explore': z.strictObject({ stepId: z.uuid(), request: BrowserExploreRequestSchema }),
    'probe.run': z.strictObject({ stepId: z.uuid(), probe: ProbeSchema, evidence: EvidenceRequestSchema.optional() }),
    'exec': z.strictObject({
        stepId: z.uuid(),
        command: z.string().min(1).max(16_384),
        cwd: z.string().max(1_024).optional(),
        timeoutMs,
        stream: z.boolean().optional(),
        evidence: EvidenceRequestSchema.optional(),
        // feature workspace: the alias of another repository of the claim
        // whose code the command runs on; the cell runs it in the container
        // built from that repository. Absent: the claim's own repository.
        repository: z.string().regex(REPOSITORY_ALIAS_PATTERN).optional(),
    }),
    'upload': z.strictObject({
        stepId: z.uuid(),
        files: z
            .array(
                z.strictObject({
                    // Relative to the checkout, no `.` or `..` segment.
                    path: z.string().min(1).max(1_024).regex(UPLOAD_PATH),
                    contentRef: z.string().min(1).max(1_024),
                    // The read grant of contentRef the worker signed (an
                    // evidence read URL, at most 5 minutes, that one object
                    // only): the cell GETs it over its own path, never the machine.
                    // The upload grant's host rule: https to a DNS name, or http to
                    // a local name, never an IP literal (a metadata address).
                    url: UploadGrantSchema.shape.url,
                    // The object's digest when the caller knows it: the cell refuses other bytes.
                    sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
                    mode: z.number().int().min(0).max(0o777).optional(),
                }),
            )
            .max(256),
    }),
    'exec.cancel': z.strictObject({ stepId: z.uuid() }),
    // One operation on a sandbox claim (exec or a file), hub to cell, and the
    // same frame cell to guest agent inside the machine.
    'sandbox.op': z.strictObject({ stepId: z.uuid(), op: SandboxOpCheckedSchema }),
    // The guest agent's answer to a sandbox.op (re), on its stream to the cell only.
    'guest.result': z.strictObject({ stepId: z.uuid(), result: SandboxResultSchema }),
    'machine.reset': z.strictObject({
        stepId: z.uuid(),
        snapshot: z.strictObject({
            // memory (feature snapshots): the claim's round snapshot, ref its id.
            kind: z.enum(['compose_volumes', 'disk', 'memory']),
            ref: z.string().min(1).max(1_024),
        }),
    }),
    // Keep the claim's workload machine as a memory snapshot (feature
    // snapshots). template and session end the machine (the claim keeps
    // only its network until released); round restores it at once from the
    // snapshot. Answered by step.result snapshot.
    'claim.snapshot': z.strictObject({ stepId: z.uuid(), purpose: z.enum(SNAPSHOT_PURPOSES) }),
    // After the probes, on the PR claim (feature exercisedLines): count the
    // changed lines its services ran. Answered by step.result exercised.
    'claim.exercised': z.strictObject({ stepId: z.uuid(), exercised: ExercisedRequestSchema }),
    'step.result': z.strictObject({
        stepId: z.uuid(),
        executor: z.enum(['observer', 'vm']),
        imageId: id,
        vmHealth: z.enum(VM_HEALTH),
        exec: z
            .strictObject({
                exitCode: z.number().int(),
                stdout: z.string().max(STEP_EXEC_OUTPUT_MAX),
                stderr: z.string().max(STEP_EXEC_OUTPUT_MAX),
                truncated: z.boolean(),
                outputRef: z.string().optional(),
                durationMs: z.number().int().min(0),
                // execCast: the output as an asciicast v2 artifact, uploaded with the step's cast grant.
                refs: z.array(EvidenceRefSchema).max(4).optional(),
            })
            .optional(),
        probe: ProbeResultSchema.optional(),
        browserExploration: BrowserExploreResultSchema.optional(),
        // A sandbox.op's result, as the guest agent gave it (executor vm, nothing else).
        sandbox: SandboxResultSchema.optional(),
        // claim.snapshot's: the snapshot the cell made (executor vm, nothing else).
        snapshot: z.strictObject({ id: SnapshotIdSchema, purpose: z.enum(SNAPSHOT_PURPOSES), ms }).optional(),
        // claim.exercised's: line counts per changed file (executor vm, nothing else).
        exercised: ExercisedResultSchema.optional(),
        // How many values the cell replaced with [redacted:<rule>] in this
        // result before it left the cell (S-51).
        redactions: z.number().int().min(0).optional(),
        // How long the step ran on the cell, in ms (set for machine.reset:
        // down, up, migrate, seed and ready of the reset).
        durationMs: ms.optional(),
    }).superRefine((b, ctx) => {
        if (b.sandbox && (b.exec || b.probe || b.browserExploration || b.executor !== 'vm')) ctx.addIssue({ code: 'custom', message: 'a sandbox result is an exclusive vm result', path: ['sandbox'] });
        if (b.snapshot && (b.exec || b.probe || b.browserExploration || b.sandbox || b.executor !== 'vm')) ctx.addIssue({ code: 'custom', message: 'a snapshot result is an exclusive vm result', path: ['snapshot'] });
        if (b.exercised && (b.exec || b.probe || b.browserExploration || b.sandbox || b.snapshot || b.executor !== 'vm')) ctx.addIssue({ code: 'custom', message: 'an exercised result is an exclusive vm result', path: ['exercised'] });
        if (b.browserExploration && (b.exec || b.probe || b.executor !== 'observer')) ctx.addIssue({ code: 'custom', message: 'browser exploration is an exclusive observer result', path: ['browserExploration'] });
        // A probe result comes from the observer, an exec result from the VM,
        // never both: a result that says otherwise is refused, not guessed.
        if (b.probe && b.exec) ctx.addIssue({ code: 'custom', message: 'a step result carries a probe or an exec result, not both', path: ['exec'] });
        if (b.probe && b.executor !== 'observer') ctx.addIssue({ code: 'custom', message: 'a probe result comes from the observer', path: ['executor'] });
        if (b.exec && b.executor !== 'vm') ctx.addIssue({ code: 'custom', message: 'an exec result comes from the VM', path: ['executor'] });
    }),
    'step.stream': z.strictObject({ stepId: z.uuid(), chunk: z.string().max(STEP_STREAM_CHUNK_MAX) }),
    // Only for a commit the worker checked is the default branch head (S-52);
    // never tied to a PR claim (the hub refuses, the cell nacks).
    'image.bake': z.strictObject({
        environmentId: id,
        orgId: id,
        recipeSha: z.string().min(1).max(128),
        sha: z.string().regex(/^[0-9a-f]{40}$/),
        // A multi-repository environment's bake key (contracts/workspace.ts
        // refsDigest): every repository's commit and the recipe. Absent for
        // an environment of one repository, whose key is sha and recipeSha.
        refsDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/).optional(),
    }),
    // Cell to hub, unsolicited (feature bakeShare, only to a hub that accepts
    // it): what a bake pushed to the org's registry, after the bake. The key
    // is the image.bake's own (orgId, environmentId, sha or refsDigest,
    // recipeSha); the hub records it only for a bake it asked of this cell.
    'image.shared': z.strictObject({
        orgId: id,
        environmentId: id,
        recipeSha: z.string().min(1).max(128),
        sha: z.string().regex(/^[0-9a-f]{40}$/),
        refsDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/).optional(),
        images: z.array(SharedImageSchema).min(1).max(MAX_SHARED_IMAGES),
    }),
    // The org's sessions to remove at once (their PR closed or merged); a
    // template or a round is not one, and the cell refuses those.
    'snapshot.forget': z.strictObject({
        orgId: id,
        snapshotIds: z.array(SnapshotIdSchema).min(1).max(64),
    }),
    'pool.target': z.strictObject({
        orgId: id,
        environmentId: id,
        imageId: id,
        size: z.number().int().min(0).max(100),
        // The environment's machine size (claim.acquire size): the pool's
        // machines are made at it, so a claim of that size adopts one. A new
        // size drains the machines of the old one. Absent: the cell's default.
        machineSize: MachineSizeSchema.optional(),
    }),
    // A reply (re) to a request the hub sent, or, unsolicited (claimId, no re),
    // a security_violation the cell saw on one of its claims.
    'blocked': z
        .strictObject({
            kind: BlockerKindSchema,
            signature: z.string().min(1).max(256),
            evidenceRef: z.string().max(1_024).optional(),
            message: z.string().max(BLOCKED_MESSAGE_MAX),
        })
        .refine((b) => b.kind !== 'security_violation' || SECURITY_VIOLATION_SIGNATURE.test(b.signature), {
            message: 'a security_violation signature is the alert kind (lower snake case, at most 64 characters)',
            path: ['signature'],
        }),
    'egress.blocked': z.strictObject({
        host: z.string().max(256),
        sni: z.string().max(256).optional(),
        port: z.number().int().min(1).max(65_535),
        phase: z.enum(['build', 'test']),
        at: z.iso.datetime(),
    }),
    // Where a claim's preparation is (unsolicited, claimId, best effort: a
    // lost one fails nothing): a phase that started or ended and, while a
    // build or compose runs, the last lines of its output, redacted by the
    // cell. The worker shows it on the setup, so a long boot is never silent.
    'claim.progress': z.strictObject({
        phase: z.string().regex(/^[a-z][a-z_]{0,31}$/),
        state: z.enum(['started', 'done']),
        at: z.iso.datetime(),
        ms: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
        lines: z.array(z.string().max(LOG_LINE_MAX)).max(40).optional(),
        // Where the boot spent its time so far (the build's phases, the one
        // running marked so); only to a hub whose hello ack accepts
        // bootPhases. A boot the hub stops at its ceiling sends no
        // claim.failed: this is what says where it was.
        phases: BootPhasesSchema.optional(),
    }),
    // The claim's full allowlist, replacing the previous one (an approved
    // egress request reaches live claims without a new claim).
    'egress.policy': z.strictObject({
        allow: z.array(hostname).max(256),
        // Feature egressTiers: the hosts of allow approved as inspected.
        inspect: EgressInspectListSchema.optional(),
        issuedAt: z.iso.datetime(),
        // Seals a sandbox claim's egress for good (the product asks it once the
        // checkout is prepared): from then on its signed policy allows nothing,
        // whatever any later egress.policy or the cell's own lists say. Only on a
        // sandbox claim, with an empty allow and no inspect; acked after the
        // enforcers hold the sealed policy. An older cell refuses the field
        // (strict body), so a seal never silently does nothing.
        sealed: z.literal(true).optional(),
    }).refine((b) => !b.sealed || (b.allow.length === 0 && !b.inspect?.length), {
        message: 'a sealed egress policy allows nothing: allow and inspect are empty',
        path: ['sealed'],
    }),
    // Dial the preview edge (feature preview): one more outbound WebSocket,
    // with the cell's own client certificate and this one-time ticket, that
    // carries HTTP/2 with the cell as the server. Sent before the cell's
    // first route and whenever the edge has no tunnel of this cell.
    'preview.tunnel': z.strictObject({
        url: z.string().max(512).regex(PREVIEW_TUNNEL_URL_PATTERN),
        ticket: z.string().regex(PREVIEW_TUNNEL_TICKET_PATTERN),
        expiresAt: z.iso.datetime(),
    }),
    // Serve tunnel streams of this preview id to this claim's http expose
    // entry, through its observer, until `until` (the claim's lease) or an
    // unroute. A target outside the claim's expose, or not http, is nacked.
    'preview.route': z.strictObject({
        previewId: PreviewIdSchema,
        target: z.strictObject({ service: z.string().min(1).max(128), port: z.number().int().min(1).max(65_535) }),
        until: z.iso.datetime(),
    }),
    // Refuse the preview id from now on and close its open streams.
    'preview.unroute': z.strictObject({ previewId: PreviewIdSchema }),
    'cell.revoked': z.strictObject({ reason: z.string().max(512) }),
    // version is set only on the ack of hello: the version the hub chose (§1b).
    // accepts too, and only with names the cell's hello named
    // (HUB_ACCEPTED_FEATURES): the optional fields the cell may send this hub.
    // cellProtocols too, and only to a cell that named the feature: the cell
    // protocol versions this hub accepts at hello.
    'ack': z.strictObject({
        version: z.number().int().min(1).optional(),
        accepts: z.array(CellFeatureNameSchema).max(64).optional(),
        cellProtocols: z.strictObject({ min: z.number().int().min(1), max: z.number().int().min(1) }).optional(),
    }),
    'nack': z.strictObject({
        code: z.string().min(1).max(64),
        message: z.string().max(1_024),
    }),
} as const;

export type MessageType = keyof typeof MessageBodySchemas;
export type RepoRef = z.infer<typeof RepoRefSchema>;
export const MESSAGE_TYPES = Object.keys(MessageBodySchemas) as MessageType[];

export type MessageBody<T extends MessageType> = z.infer<(typeof MessageBodySchemas)[T]>;
