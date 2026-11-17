import type { BlockerFixView } from '@libs/runtime/blockers/catalog';
import type { BrowserExploreRequest, BrowserExploreResult } from '@libs/runtime/contracts/browser-exploration';
import type { BlockerKind, CellOwner, ClaimConsumer, ClaimSide, Expose as SharedExpose, VmHealth as SharedVmHealth } from '@libs/runtime/contracts/enums';
import type { EvidenceRef, Probe, ProbeResult } from '@libs/runtime/probe';
import type { MachineSize } from '@libs/runtime/contracts/machine-size';
import type { IsolationMinimum } from '@libs/runtime/contracts/isolation';
import type { BootPhases, BuildSteps, ClaimCanary, ClaimRunIdentity, EvidenceRequest, ExercisedRequest, ExercisedResult, FailureBundle } from '@libs/runtime/protocol';

// The one door every consumer uses to get "this app up at this SHA"
// (docs §5, ADR-002). The control plane never talks to a cloud or a machine:
// it sends messages through the hub to the cell.

export type { ClaimSide };
/** @deprecated use ClaimSide (the gate's ProbeSide has no 'setup'). */
export type Side = ClaimSide;
export type Consumer = ClaimConsumer;
export type Expose = SharedExpose;

export interface AcquireRequest {
    organizationId: string;
    environmentId: string;
    runId?: string;
    imageId?: string;
    ref: { side: ClaimSide; sha: string };
    consumer: Consumer;
    idempotencyKey: string;
    /** Keep the machines of a failed setup for diagnosis (setup only, never a PR). */
    diagnosticHold?: boolean;
    /** A setup of the default branch: its builds' cache becomes the environment's when each build finishes (setup only, never a PR). */
    seedsCache?: boolean;
    /** The default branch's recipe the cell boots with (content null: there is none), never the checkout's. */
    recipe?: RecipeForClaim;
    /** The environment's machine size for the workload's builds and services; absent: the cell's default. */
    size?: MachineSize;
    /**
     * The least isolation the claim's machines may run under
     * (docs/runtime/isolation-architecture.md C1): 'any' (the default when
     * absent), 'kernel' (gVisor or better), 'vm' (a microVM or a VM). The
     * claim goes only to a cell that satisfies it; with none connected it is
     * blocked (kind capacity), never placed lower.
     */
    isolation?: IsolationMinimum;
    /**
     * The Run's canaries (ADR-043) for the cell to plant in the workload; only a Run's claims carry
     * them. Decoys, never a real secret, but never logged, stored or returned either.
     */
    canaries?: ClaimCanary[];
    /**
     * The Run's drawn identifiers (S-36, runIdentityOf): the same on both sides, set by a cell
     * that names runIdentity in every service's env and as the hostname. Only a Run's claims carry them.
     */
    identity?: ClaimRunIdentity;
    /**
     * The PR side of a pull request from a fork: code nobody in the org wrote.
     * The environment's approved egress hosts never reach its claim.
     */
    forkPullRequest?: boolean;
    /**
     * A preview claim of an environment an owner set to "same as the Run"
     * (docs/runtime/preview-urls.md §7): the org's secrets reach it as
     * placeholders, as a Run's do. Never on a fork's PR side.
     */
    previewSecrets?: boolean;
}

export interface RecipeForClaim {
    path: string;
    /** null or absent: the default branch has no recipe. */
    content?: string | null;
    digest?: string;
    /** The files Kody wrote with an authored recipe (only with a content), written by the cell under .kodus/ before it boots. */
    files?: Array<{ path: string; content: string }>;
}

export interface Claim {
    /** Only when the owning cell negotiated local native browser exploration. */
    capabilities?: { browserExplore: 'v1' };
    /**
     * The Run's drawn identifiers the cell set in this claim's workload (AcquireRequest.identity);
     * absent when it did not (an older cell, a setup): the workload keeps the recipe's own values.
     */
    identity?: ClaimRunIdentity;
    claimId: string;
    cellId: string;
    cellOwner: CellOwner;
    leaseExpiresAt: string;
    hardExpiresAt: string;
    observer: { id: string; state: 'creating' | 'ready' | 'failed' };
    manifest: {
        services: { name: string; health: 'ok' | 'failed' }[];
        expose: Expose[];
        imageId: string;
        seedSha: string;
    };
    /**
     * The cell had removed this environment's build state to free disk (its
     * heartbeat evictedBuildStates) and no setup made it again: the claim's
     * builds ran with no state, so the boot was cold. ISO time of the eviction.
     */
    buildStateEvictedAt?: string;
    /** How long the claim took on the cell (claim.ready.timing), in ms; absent from a cell that does not send it. */
    timing?: { prepareMs: number; bootMs?: number; buildMs?: number; upMs?: number; seedMs?: number; readyMs?: number; snapshotMs?: number; buildSteps?: BuildSteps; phases?: BootPhases };
}

/** A claim's claim.ready.timing: the cell agent's prepare time and the driver's boot phases, in ms. */
export type ClaimTiming = NonNullable<Claim['timing']>;

/**
 * A claim.renew through the hub. `renewed`: the lease now ends at
 * leaseExpiresAt, never past hardExpiresAt (atCeiling: it reached it, so a
 * later renew cannot move it). `gone`: the claim was released, finished or is
 * unknown to its cell; there is nothing left to keep.
 */
export type LeaseRenewal = { status: 'renewed'; leaseExpiresAt: string; hardExpiresAt: string; atCeiling: boolean } | { status: 'gone' };

/**
 * Why a claim did not come up, typed (docs §5 Blocker). `kind` is one of
 * BLOCKER_KINDS; a kind this side does not know reads `unknown`
 * (typed-blocker.ts blockerKindOf, at the worker's border with the hub).
 * `title`, `evidence` and `fixes` are the shared catalog's card
 * (libs/runtime/blockers/catalog.ts), filled where the blocker is classified;
 * absent on a blocker nothing classified yet. The blocker's id, state and
 * seen counts live in the setup record, never here.
 */
export interface Blocker {
    kind: BlockerKind;
    signature: string;
    message: string;
    /** The card's plain-language title (a template of checked identifiers, S-23). */
    title?: string;
    evidence?: BlockerEvidenceOfClaim;
    /** The catalog's fixes, in order, the first one recommended. */
    fixes?: BlockerFixView[];
    /** The repository of a multi-repository environment the blocker is about (its alias); absent: the claim's own, or not known. */
    alias?: string;
    /** The cell's redacted failure bundle of a setup claim. */
    bundle?: FailureBundle;
    /** Where the failed boot spent its time until it stopped (claim.failed phases). */
    phases?: BootPhases;
}

/** What the blocker was read from (docs §5 evidence): the matched lines, redacted by the cell. */
export interface BlockerEvidenceOfClaim {
    /** The step whose output the lines came from, when a step was the source. */
    stepId?: string;
    lines: string[];
    /** The egress proxy's lines about the denied hosts, when the blocker is outbound access. */
    proxyLog?: string[];
    service?: string;
}

export interface Blocked {
    status: 'blocked';
    blockers: Blocker[];
    /** The failed claim kept for a diagnostic hold until hardExpiresAt (exec and release only). */
    held?: { claimId: string; cellId: string; hardExpiresAt: string };
    /** The cell the claim was booting on when it failed or timed out: it may hold what the build left (its state, its cache). */
    cellId?: string;
    /** As Claim.buildStateEvictedAt: the boot that failed or timed out built with no state, because the cell had evicted it. */
    buildStateEvictedAt?: string;
    /**
     * Nothing was started because no cell had room for the claim now
     * (ADR-070): the worker waits and asks again (isCapacityWait). The
     * numbers are the cell's memory, when it was memory and not a slot.
     */
    capacity?: CapacityWait;
}

/** Why a claim waits for room on a cell (Blocked.capacity), in MB. */
export interface CapacityWait {
    cellId?: string;
    needMb?: number;
    freeMb?: number;
    allocatableMb?: number;
    /** Claims that asked this cell before this one and still wait: they go first. */
    ahead?: number;
}

/**
 * The signatures of a claim that waited for room, never started: no cell had
 * a slot or the memory (no_capacity), or the org holds its cap of shared
 * machines (org_capacity). Never a failure of the claim: wait and ask again.
 */
export const CAPACITY_WAIT_SIGNATURES = ['no_capacity', 'org_capacity'] as const;

/** A blocked acquire that only waited for room (CAPACITY_WAIT_SIGNATURES): ask again later. */
export const isCapacityWait = (r: Claim | Blocked): r is Blocked =>
    (r as Blocked).status === 'blocked' &&
    (r as Blocked).blockers.length > 0 &&
    (r as Blocked).blockers.every((b) => b.kind === 'resources' && (CAPACITY_WAIT_SIGNATURES as readonly string[]).includes(b.signature));

/** image.bake: only for a default-branch commit, never tied to a PR claim (S-52). */
export interface BakeRequest {
    organizationId: string;
    environmentId: string;
    recipeSha: string;
    sha: string;
    /** The setup claim that booted this commit, when the bake follows a setup. */
    claimId?: string;
    /**
     * A multi-repository environment's bake key (contracts/workspace refsDigest):
     * only for a setup claim that carried other repositories, never for one of one.
     */
    refsDigest?: string;
}

export type BakeOutcome = { status: 'accepted' } | { status: 'refused'; code: string; message: string };

/**
 * pool.target to the cell that ran the setup: keep `size` clean machines
 * ready for the environment, made from its latest bake there (S-52). Sent
 * right after image.bake is accepted, so the cell waits for that bake.
 */
export interface PoolTargetRequest {
    organizationId: string;
    environmentId: string;
    size: number;
    /** The environment's machine size: the pool's machines are made at it, so its Runs' sized claims adopt them. Absent: the cell's default. */
    machineSize?: MachineSize;
    cellId: string;
    /** The setup claim, only to find the hub replica that holds the cell. */
    claimId: string;
}

/**
 * The hub's refusal of a sized environment's pool on a cell too old to make
 * pool machines at a size (no poolMachineSize in its hello): it drained the
 * default-size pool, which no Run of that environment could adopt.
 */
export const POOL_SIZE_UNSUPPORTED = 'pool_size_unsupported';

export type VmHealth = SharedVmHealth;

/** A probe result with the health of the machine it ran against (step.result.vmHealth). */
export type ProbeOutcome = ProbeResult & { vmHealth: VmHealth };

export type EnvError =
    /** This current cell cannot prove exec stays inside an isolated workload. */
    | { code: 'workload_exec_unavailable' }
    | { code: 'lease_expired' }
    /** The observer gave no result and the cell reports the machine OOM, crashed or gone. */
    | { code: 'vm_unhealthy'; stepId: string; vmHealth: Exclude<VmHealth, 'ok'> }
    | { code: 'cell_unavailable'; cellId: string }
    | { code: 'timeout'; afterMs: number }
    | { code: 'transport_lost'; stepId: string }
    /** The cell saw the claim's code exfiltrate (blocked security_violation): the claim runs nothing more. */
    | { code: 'security_violation'; claimId: string; signature: string }
    /** The claim's cell cannot take files (it answered the upload not_implemented or not_supported): nothing was written. */
    | { code: 'upload_unavailable' }
    /** An upload that wrote nothing: a ref that is no object of the claim's org, or bytes the cell refused (over the bound, not the digest, a write the machine refused). */
    | { code: 'upload_failed'; stepId: string; reason: string };

/**
 * upload (docs §5): files written into the claim's checkout from the evidence
 * store, the protocol's `upload` frame. stepId is the cell's idempotency key;
 * each path is relative to the checkout (no `.` or `..` segment), at most 256 files.
 */
export interface UploadRequest {
    stepId: string;
    files: Array<{ path: string; contentRef: string; sha256?: string; mode?: number }>;
}

/**
 * status (docs §5): how an environment boots, from what the product already
 * keeps (its setup record: state, image, cell, the week's setup boots, the open
 * blockers); never a call to a cell or a cloud. not_set_up: no setup of that org's
 * environment was ever recorded.
 */
export interface EnvironmentHealth {
    environmentId: string;
    state: 'setting_up' | 'active' | 'blocked' | 'not_set_up';
    /** Setup boots of the last 7 days. */
    boots7d: number;
    /** The share of them that became ready; absent: no boot in the week. */
    bootRate7d?: number;
    /** Their median time to ready; absent: none became ready. */
    readyP50Ms?: number;
    imageId?: string;
    cellId?: string;
    /** Grouped by signature, the most frequent first. */
    blockers: Array<{ signature: string; kind: BlockerKind; count: number; lastAt: string }>;
}

export interface ExecRequest {
    /** Hub-side execution policy only; never sent in a cell frame. */
    executionScope?: 'workload';
    stepId: string;
    command: string;
    cwd?: string;
    timeoutMs: number;
    /** What the cell captures around the command (execCast) and the grants it uploads with; a cell without the feature captures nothing. */
    evidence?: EvidenceRequest;
    /**
     * The alias of another repository of a multi-repository claim whose code
     * the command runs on (the PR's, when the PR is in a member): the cell runs
     * it where that repository was built. Absent: the claim's own repository.
     */
    repository?: string;
}

export interface StepResult {
    stepId: string;
    exitCode: number;
    stdout: string;
    stderr: string;
    truncated: boolean;
    durationMs: number;
    transport: 'ok' | 'lost';
    /** Values the cell replaced with [redacted:<rule>] in this result (S-51). */
    redactions?: number;
    /** What the cell uploaded with the step's grants (the cast); absent: not captured. */
    refs?: EvidenceRef[];
}

/** What the caller of an acquire knows that the request does not carry; never sent to a cell. */
export interface AcquireOptions {
    /**
     * When the claim's boot must be ready (epoch ms). Set when the claim's boot
     * began on an earlier call (a worker that restarted mid-boot): the call waits
     * only what is left of the ready wait, and answers boot_timeout once it has
     * passed. Absent: the hub's whole ready wait, as on a first call.
     */
    readyBy?: number;
}

export interface EnvironmentRuntime {
    /** Local UI exploration only: never returned to the replay gate. */
    exploreBrowser?(claimId: string, request: BrowserExploreRequest, stepId: string): Promise<BrowserExploreResult | EnvError>;
    acquire(req: AcquireRequest, opts?: AcquireOptions): Promise<Claim | Blocked>;
    /** Runs on the claim's observer, outside the VM (ADR-053). */
    probe(claimId: string, probe: Probe, stepId: string, evidence?: EvidenceRequest): Promise<ProbeOutcome | EnvError>;
    /** Runs inside the VM: setup and internal evidence only. */
    exec(claimId: string, req: ExecRequest): Promise<StepResult | EnvError>;
    /**
     * machine.reset from outside the guest; imageId pins the acquired image for this Run (ADR-050).
     * With roundSnapshotId the claim's machine comes back from that round snapshot (kind memory)
     * instead of its compose volumes.
     */
    reset(claimId: string, imageId?: string, roundSnapshotId?: string): Promise<void | EnvError>;
    /**
     * claim.snapshot round: the claim's workload kept as a memory snapshot at its first ready, which
     * later resets name. Absent where the environment keeps none; a cell without snapshots answers an EnvError.
     */
    snapshotRound?(claimId: string, stepId: string): Promise<{ id: string; ms: number } | EnvError>;
    /**
     * claim.exercised on the PR claim (feature exercisedLines): which changed lines its services ran.
     * Undefined when the cell does not name the feature, so nothing was asked. Absent where the
     * environment cannot ask.
     */
    exercisedLines?(claimId: string, stepId: string, request: ExercisedRequest): Promise<ExercisedResult | undefined | EnvError>;
    release(claimId: string): Promise<void>;
    /** Writes files into the claim's checkout (the protocol's upload); absent where a driver has none. */
    upload?(claimId: string, req: UploadRequest): Promise<void | EnvError>;
    /** The environment's health (EnvironmentHealth), read only for that org; absent where a driver has none. */
    status?(req: { organizationId: string; environmentId: string }): Promise<EnvironmentHealth>;
    /** claim.renew: more lease for a claim its owner still uses, never past its hard ceiling; absent where leases are not renewed. */
    renew?(claimId: string, consumer: Consumer): Promise<LeaseRenewal | EnvError>;
    /** Asks the cell to bake the environment image (S-52); absent where there is no bake. */
    bake?(req: BakeRequest): Promise<BakeOutcome>;
    poolTarget?(req: PoolTargetRequest): Promise<BakeOutcome>;
    /** Where an acquire's preparation is (the cell's claim.progress), while it runs; null when unknown. */
    progress?(req: { organizationId: string; idempotencyKey: string }): Promise<ClaimProgress | null>;
}

/** A claim's preparation as its cell reports it: each phase and the last lines of the running one. */
export type ClaimProgress = {
    phases: Array<{ phase: string; state: 'started' | 'done'; at: string; ms?: number }>;
    lines: string[];
    updatedAt: string;
    /** Where the boot spent its time so far (claim.progress phases), when the cell sent it. */
    bootPhases?: BootPhases;
};

/** How long a claim's lease lasts before it must be renewed, by consumer. */
// A setup's lease is its whole ceiling: nothing sends claim.renew while it boots, and a
// large build (Grafana's backend: ~35 min) outlives a shorter lease and is swept mid-build.
// A sandbox's lease matches the review's sandbox lease (30 min); its ceiling the E2B sandbox's order of magnitude.
// A preview's lease is its idle stop (15 min, renewed by the edge's traffic) and its ceiling one start (2 h): docs/runtime/preview-urls.md §5.2.
export const LEASE_TTL_MINUTES: Record<Consumer, number> = { runtime: 45, setup: 45, mcp: 120, custom_agent: 30, sandbox: 30, preview: 15 };
/** When a claim's machines are destroyed whatever the lease says, by consumer. */
export const HARD_EXPIRY_MINUTES: Record<Consumer, number> = { runtime: 60, setup: 45, mcp: 240, custom_agent: 45, sandbox: 45, preview: 120 };
/**
 * How long the hub waits from claim.acquire to claim.ready, by consumer. A
 * Run boots on a baked image; a setup builds from zero, so it waits until a
 * minute before its own ceiling, never past it (the cell destroys the
 * machines at hardExpiresAt). The worker's call waits a minute more.
 */
const PR_BUILD_READY_TIMEOUT_MINUTES_VALUE = 30;
export const READY_TIMEOUT_MINUTES: Record<Consumer, number> = {
    runtime: 15,
    setup: HARD_EXPIRY_MINUTES.setup - 1,
    mcp: 15,
    custom_agent: 15,
    // One tool container and no build: a sandbox is ready in seconds, or never.
    sandbox: 2,
    // A preview's PR side builds the pull request's commit, as the Run's did.
    preview: PR_BUILD_READY_TIMEOUT_MINUTES_VALUE,
};
/**
 * A Run's PR side does not boot on the baked image: the cell builds the pull
 * request's commit. On a heavy repository that build is the boot (kr-directus:
 * 13 min 37 s, and the Run gave up at 15 min in the second the build ended).
 * It waits twice as long as the base side, and still ends half an hour before
 * the claim's hard ceiling, which is left for the probes.
 */
export const PR_BUILD_READY_TIMEOUT_MINUTES = PR_BUILD_READY_TIMEOUT_MINUTES_VALUE;

/** READY_TIMEOUT_MINUTES for one claim: the PR side of a Run waits for its build. */
export function readyTimeoutMinutes(consumer: Consumer, side?: string): number {
    return consumer === 'runtime' && side === 'pr' ? PR_BUILD_READY_TIMEOUT_MINUTES : READY_TIMEOUT_MINUTES[consumer];
}

/**
 * When a claim's boot must be ready, from the hard ceiling its boot round was
 * given (the hub sets hardExpiresAt to the round's start plus
 * HARD_EXPIRY_MINUTES and keeps it for a retried round on the same cell):
 * the round's start plus the claim's ready wait.
 */
export function readyDeadlineOf(hardExpiresAt: string, consumer: Consumer, side?: string): number {
    return Date.parse(hardExpiresAt) - HARD_EXPIRY_MINUTES[consumer] * 60_000 + readyTimeoutMinutes(consumer, side) * 60_000;
}

/** A boot that outlived its ready wait, as the hub answers it (kind resources, boot_timeout). */
export function bootTimedOut(consumer: Consumer, side?: string): Blocked {
    const minutes = readyTimeoutMinutes(consumer, side);
    return { status: 'blocked', blockers: [{ kind: 'resources', signature: 'boot_timeout', message: `the boot did not finish in ${minutes} min, the most a boot of this claim waits` }] };
}

export const isBlocked = (r: Claim | Blocked): r is Blocked => (r as Blocked).status === 'blocked';
export const isEnvError = (r: unknown): r is EnvError =>
    typeof r === 'object' && r !== null && 'code' in r && !('stepId' in r && 'executor' in r);
