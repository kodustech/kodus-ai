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
import { EVIDENCE_CONTENT_TYPES, EVIDENCE_UPLOAD_TYPES, type EvidenceUploadType } from '@libs/runtime/contracts/evidence';
import { EvidenceRefSchema, ProbeResultSchema, ProbeSchema } from '@libs/runtime/probe';

// Cell protocol bodies (docs §1b, ADR-051). Every object is strict: an
// unknown or case-variant key is refused, so TS and Go read the same frame.

const id = z.string().min(1).max(128);
const timeoutMs = z.number().int().min(1).max(600_000);
const ms = z.number().int().min(0);
// An exact hostname (lowercase, no port, no scheme). The proxy and the
// resolver compare it byte for byte; a leading "*." is not accepted.
const hostname = z
    .string()
    .min(1)
    .max(253)
    .regex(/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/);

const ExposeListSchema = z.array(ExposeSchema).max(64);

// One path segment that is not `.` or `..` (RE2 has no lookahead, and the Go
// cell compiles these patterns, so the exclusion is spelled out).
const SEGMENT = '(?:[A-Za-z0-9_-][A-Za-z0-9_.-]*|\\.[A-Za-z0-9_-][A-Za-z0-9_.-]*|\\.\\.[A-Za-z0-9_.-]+)';
// A file path segment: anything but a separator, a backslash, NUL, `.` or `..`.
const FILE_SEGMENT = '(?:[^/\\\\.\\x00][^/\\\\\\x00]*|\\.[^/\\\\.\\x00][^/\\\\\\x00]*|\\.\\.[^/\\\\\\x00]+)';
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
 *   - browser: the cell plays browser probes in its browser runner (ADR-071).
 *     Both ways: the hub sends the browser capture, its upload grants and
 *     the baseline screenshots only to a cell that names it, and the cell
 *     sends probe.browser (steps, pixel diffs, network, console) only to a
 *     hub that accepts it. A cell without it refuses a browser probe with
 *     browser_unavailable, as before the runner existed.
 */
export const CELL_FEATURES = [
    'seedsCache',
    'claimSize',
    'egressAllow',
    'poolMachineSize',
    'authoredFiles',
    'readyBuildSteps',
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
] as const;
export type CellFeature = (typeof CELL_FEATURES)[number];

/**
 * The optional fields a cell may send that a hub older than them refuses
 * (its decoder is strict). A cell names the feature in hello; a hub that
 * accepts the field echoes the name in the hello ack's `accepts`, and only
 * then does the cell send it. An older hub ignores the unknown name and acks
 * without `accepts`, so it never sees the field; an older cell never names
 * it, so it never gets an ack with `accepts` it would refuse.
 */
export const HUB_ACCEPTED_FEATURES = ['readyBuildSteps', 'cellMemory', 'timedRequests', 'serviceLogs', 'dbEffects', 'outboundCalls', 'execCast', 'browser', 'browserExplore'] as const satisfies readonly CellFeature[];
export type HubAcceptedFeature = (typeof HUB_ACCEPTED_FEATURES)[number];

/** What a hello ack's `accepts` names: the cell's features this hub accepts fields of. Empty: send `accepts` not at all. */
export function hubAccepts(cellFeatures: readonly string[] | undefined): HubAcceptedFeature[] {
    return HUB_ACCEPTED_FEATURES.filter((f) => cellFeatures?.includes(f));
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
                logTail: z.array(z.string().max(2_048)).max(500),
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

export const MessageBodySchemas = {
    'hello': z.strictObject({
        versions: z.array(z.number().int().min(1)).min(1).max(16),
        driver: z.string().min(1).max(64),
        // 'none' is the dev-only local-docker driver; a hub refuses it unless
        // it runs with RUNTIME_DEV_ALLOW_INSECURE_CELLS=1.
        isolation: z.enum(['vm', 'microvm', 'sandboxed-container', 'none']),
        regions: z.array(z.string().max(64)).max(64),
        owner: z.enum(CELL_OWNERS),
        // The optional claim.acquire fields this cell decodes (CELL_FEATURES).
        // The hub sends a cell only the fields it named, so a newer hub never
        // breaks an older cell's strict decoder. Absent: none. Plain names,
        // not an enum, so a newer cell's feature an older hub does not know
        // is ignored by that hub instead of refusing the hello.
        features: z.array(CellFeatureNameSchema).max(32).optional(),
        // The largest size the cell grants one claim (its driver's maximum,
        // clamped to MACHINE_SIZE_LIMITS: no claim asks more). Absent: it
        // grants none, and the hub sends it no sized claim.
        maxClaimSize: MachineSizeSchema.optional(),
    }),
    'heartbeat': z.strictObject({
        claims: z.array(z.strictObject({ claimId: id, machines: z.number().int().min(0) })).max(1_024),
        freeSlots: z.number().int().min(0),
        // Only to a hub whose hello ack accepts cellMemory (ADR-070).
        memory: HeartbeatMemorySchema.optional(),
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
        // The environment's machine size for this claim's workload: the
        // memory and CPUs every build and service gets. The cell refuses a
        // size above the largest it grants (blocker resources/size_unavailable)
        // before it creates anything. Absent: the cell's default size.
        size: MachineSizeSchema.optional(),
        // The Run's canaries (ADR-043), one per slot at most: the cell
        // plants them in the workload (env and a credentials file), never
        // in a label, a log or anything it sends back.
        canaries: z.array(ClaimCanarySchema).max(CANARY_SLOTS.length).optional(),
    }).refine((b) => !b.diagnosticHold || b.consumer === 'setup', {
        message: 'only a setup claim may ask for a diagnostic hold',
        path: ['diagnosticHold'],
    }).refine((b) => !b.seedsCache || (b.consumer === 'setup' && b.side !== 'pr'), {
        message: 'only a setup claim that is not a PR may seed the build cache',
        path: ['seedsCache'],
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
            })
            .optional(),
    }),
    // The claim will never be ready; the cell has already cleaned it up.
    // With held: true the cell kept the machines for a diagnostic hold until
    // hardExpiresAt (only exec and claim.release are accepted on the claim).
    'claim.failed': z.strictObject({
        kind: BlockerKindSchema,
        signature: z.string().min(1).max(256),
        reason: z.string().max(4_096),
        bundle: FailureBundleSchema.optional(),
        held: z.boolean().optional(),
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
    }),
    'upload': z.strictObject({
        stepId: z.uuid(),
        files: z
            .array(
                z.strictObject({
                    // Relative to the checkout, no `.` or `..` segment.
                    path: z
                        .string()
                        .min(1)
                        .max(1_024)
                        .regex(new RegExp(`^${FILE_SEGMENT}(/${FILE_SEGMENT})*$`)),
                    contentRef: z.string().min(1).max(1_024),
                    mode: z.number().int().min(0).max(0o777).optional(),
                }),
            )
            .max(256),
    }),
    'exec.cancel': z.strictObject({ stepId: z.uuid() }),
    'machine.reset': z.strictObject({
        stepId: z.uuid(),
        snapshot: z.strictObject({
            kind: z.enum(['compose_volumes', 'disk']),
            ref: z.string().min(1).max(1_024),
        }),
    }),
    'step.result': z.strictObject({
        stepId: z.uuid(),
        executor: z.enum(['observer', 'vm']),
        imageId: id,
        vmHealth: z.enum(VM_HEALTH),
        exec: z
            .strictObject({
                exitCode: z.number().int(),
                stdout: z.string().max(16_384),
                stderr: z.string().max(16_384),
                truncated: z.boolean(),
                outputRef: z.string().optional(),
                durationMs: z.number().int().min(0),
                // execCast: the output as an asciicast v2 artifact, uploaded with the step's cast grant.
                refs: z.array(EvidenceRefSchema).max(4).optional(),
            })
            .optional(),
        probe: ProbeResultSchema.optional(),
        browserExploration: BrowserExploreResultSchema.optional(),
        // How many values the cell replaced with [redacted:<rule>] in this
        // result before it left the cell (S-51).
        redactions: z.number().int().min(0).optional(),
        // How long the step ran on the cell, in ms (set for machine.reset:
        // down, up, migrate, seed and ready of the reset).
        durationMs: ms.optional(),
    }).superRefine((b, ctx) => {
        if (b.browserExploration && (b.exec || b.probe || b.executor !== 'observer')) ctx.addIssue({ code: 'custom', message: 'browser exploration is an exclusive observer result', path: ['browserExploration'] });
        // A probe result comes from the observer, an exec result from the VM,
        // never both: a result that says otherwise is refused, not guessed.
        if (b.probe && b.exec) ctx.addIssue({ code: 'custom', message: 'a step result carries a probe or an exec result, not both', path: ['exec'] });
        if (b.probe && b.executor !== 'observer') ctx.addIssue({ code: 'custom', message: 'a probe result comes from the observer', path: ['executor'] });
        if (b.exec && b.executor !== 'vm') ctx.addIssue({ code: 'custom', message: 'an exec result comes from the VM', path: ['executor'] });
    }),
    'step.stream': z.strictObject({ stepId: z.uuid(), chunk: z.string().max(65_536) }),
    // Only for a commit the worker checked is the default branch head (S-52);
    // never tied to a PR claim (the hub refuses, the cell nacks).
    'image.bake': z.strictObject({
        environmentId: id,
        orgId: id,
        recipeSha: z.string().min(1).max(128),
        sha: z.string().regex(/^[0-9a-f]{40}$/),
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
            message: z.string().max(4_096),
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
        lines: z.array(z.string().max(2_048)).max(40).optional(),
    }),
    // The claim's full allowlist, replacing the previous one (an approved
    // egress request reaches live claims without a new claim).
    'egress.policy': z.strictObject({
        allow: z.array(hostname).max(256),
        issuedAt: z.iso.datetime(),
    }),
    'cell.revoked': z.strictObject({ reason: z.string().max(512) }),
    // version is set only on the ack of hello: the version the hub chose (§1b).
    // accepts too, and only with names the cell's hello named
    // (HUB_ACCEPTED_FEATURES): the optional fields the cell may send this hub.
    'ack': z.strictObject({ version: z.number().int().min(1).optional(), accepts: z.array(CellFeatureNameSchema).max(32).optional() }),
    'nack': z.strictObject({
        code: z.string().min(1).max(64),
        message: z.string().max(1_024),
    }),
} as const;

export type MessageType = keyof typeof MessageBodySchemas;
export type RepoRef = z.infer<typeof RepoRefSchema>;
export const MESSAGE_TYPES = Object.keys(MessageBodySchemas) as MessageType[];

export type MessageBody<T extends MessageType> = z.infer<(typeof MessageBodySchemas)[T]>;
