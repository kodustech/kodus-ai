import { type IsolationMinimum, IsolationMinimumSchema } from '@libs/runtime/contracts/isolation';
import { createPublicKey } from 'crypto';
import { envInteger, requireEnvInt } from '@libs/runtime/contracts/env-int';
import { DEFAULT_EXERCISED_LINES_THRESHOLD_PERCENT, DEFAULT_MAX_TOKENS_PER_RUN } from '@libs/runtime/contracts/limits';
import { readFileSync } from 'fs';

import { z } from 'zod';

import { loadS3EvidenceConfig, type S3EvidenceConfig } from '@libs/runtime/contracts/evidence-s3';
import { sealingKeyFrom, SETUP_AUTHOR_REPAIRS_DEFAULT, SETUP_AUTHOR_REPAIRS_MAX } from '@libs/runtime/run';
import { signUploadGrant } from '@libs/runtime/contracts/evidence';
import { UploadGrantSchema } from '@libs/runtime/protocol/messages';

import { DEFAULT_MACHINE_MINUTES_PER_ORG_DAY } from '@libs/runtime/environment/machine-minutes';
import { MACHINE_SIZE_LIMITS } from '@libs/runtime/contracts/machine-size';

import { assertProductionSecret } from '@libs/runtime/contracts/production-secrets';
import { isSameSite, PREVIEW_SESSION_MAX_HOURS, PREVIEW_SESSION_REVALIDATE_MINUTES, PREVIEW_TUNNEL_URL_PATTERN, PreviewDomainSchema } from '@libs/runtime/contracts/preview';

import { DEFAULT_ORG_SHARED_CLAIM_CAP } from './persistence/cell-directory';
import { devSealKey } from '../testing/dev-seal-key';
import { ADMISSION_BYTE_LIMITS, type AdmissionLimits } from './admission/admission-contract';

// Runtime configuration, read and validated once at boot (fail fast). The
// Runtime has its own Postgres database, its own broker user and no Git or
// LLM credential (ADR-025, ADR-052, ADR-057). Nothing else in apps/runtime
// reads the process environment.

export type Env = Record<string, string | undefined>;

/** What the hub admits a code sandbox that asks no size at, on a cell that does not say (RUNTIME_SANDBOX_MEMORY_MB). */
export const DEFAULT_SANDBOX_MEMORY_MB = 2048;

export interface RuntimeConfig {
    /** Opt-in durable admission; enable on both hub and worker after release validation. */
    durableAdmission: boolean;
    databaseUrl: string;
    rabbitUrl: string;
    streamDir: string;
    /** Where the Run stream lives: the Runtime Postgres (default; the API reads it read-only) or a shared volume. */
    streamStore: 'file' | 'postgres';
    /**
     * Hub: the CA that signs cell certificates, the server certificate, and the
     * CA that issues worker certificates (workerCa, defaults to ca in dev).
     * Worker: its OU=worker client certificate. PEM contents.
     */
    tls?: { ca: string; caKey?: string; cert?: string; key?: string; workerCa?: string; workerCert?: string; workerKey?: string };
    /** Worker certificate CNs the internal listener accepts; empty = any OU=worker certificate from workerCa. */
    workerAllowedCns: string[];
    /**
     * runtime-fleet's client certificate CNs (RUNTIME_FLEET_ALLOWED_CNS): the only callers of the hub's
     * /internal/fleet routes, and refused on every worker route. Empty: the fleet routes refuse everyone.
     */
    fleetAllowedCns: string[];
    /** Managed cells (cellId → serial of their CA-signed certificate) that get a runtime_cells row at boot. */
    managedCells: Record<string, string>;
    allowInsecureCells: boolean;
    /**
     * TEST ONLY (RUNTIME_TEST_ONLY_PLAINTEXT=1): plain HTTP, cells by shared
     * token and the worker by bearer token, for the docker e2e with the TS
     * fake cell. Refused in the production image and without explicit tokens.
     */
    testOnlyPlaintext?: { internalToken: string; fleetToken?: string; cellTokens: Record<string, { token: string; owner: 'kodus' | 'customer'; orgId?: string }> };
    /** Base URL of a hub's internal listener (Run events, a release when no replica holds the cell). */
    hubUrl: string;
    replicaId: string;
    /** This replica's internal listener, as the worker reaches it (written on the cell session). */
    replicaUrl: string;
    /** Public listener: cells (/cells, /cells/register, /cells/renew, /health). */
    hubPort: number;
    /** Internal listener: worker → hub (/internal/*), private network only. */
    internalPort: number;
    metricsPort?: number;
    envDriver: 'fake' | 'hub';
    partitionConcurrency: number;
    globalConcurrency: number;
    /** Shared by legacy acquires and paired admission on hub and worker. */
    orgSharedClaimCap: number;
    /** Machine minutes per org per UTC day the hub admits claims for (RUNTIME_MACHINE_MINUTES_PER_ORG_DAY); 0 = unlimited, still counted. */
    machineMinutesPerOrgDay: number;
    /**
     * Hub: the memory (MB) a code sandbox that asks no size is admitted at on
     * a cell whose hello names no sandboxSize (RUNTIME_SANDBOX_MEMORY_MB,
     * default 2048, what such a cell counts it at). A cell that names one is
     * admitted at its own; never at the cell's default Run size.
     */
    sandboxMemoryMb: number;
    /**
     * The product Postgres, read-only, as the role that may read only the org
     * secrets' id, name and hosts (RUNTIME_PRODUCT_SECRETS_READ_URL,
     * scripts/runtime/runtime-secrets-reader-grants.sql). Absent: no claim
     * gets the org's secrets.
     */
    productSecretsReadUrl?: string;
    maxTokensPerRun: number;
    /** Product API base URL of the LLM gateway (RUNTIME_LLM_GATEWAY_URL); unset → recorded responses. */
    llmGatewayUrl?: string;
    /**
     * Preview URLs (docs/runtime/preview-urls.md). previewDomain
     * (RUNTIME_PREVIEW_DOMAIN): the registrable domain previews are served
     * under, never the one Kodus runs on; absent, previews are off and the
     * product says so. previewTunnelUrl (RUNTIME_PREVIEW_TUNNEL_URL, hub): the
     * edge's wss://…/v1/cells/tunnel the hub sends cells to dial.
     */
    previewDomain?: string;
    previewTunnelUrl?: string;
    /** True in the production image (NODE_ENV=production or RUNTIME_PRODUCTION_IMAGE=1). */
    productionImage: boolean;
}

export interface WorkerConfig extends RuntimeConfig {
    /**
     * RUNTIME_PLANNER_HOST (product or worker, default product): where a Run's test planner runs.
     * product: the product's planner endpoint. worker: this worker drives the planner and calls the
     * product's model-turn gateway (WorkerRunPlanClient); it needs RUNTIME_LLM_GATEWAY_URL.
     * Workflows planned on one host never resume on the other: the host is part of releaseVersion.
     */
    plannerHost: 'product' | 'worker';
    /** Bounded broker retries before durable Run/setup admission; independent of workflow execution. */
    brokerRetry: { maxRetries: number; delayMs: number; maxDelayMs: number };
    /** RUNTIME_BROKER_PREFETCH (1..100, default 10): unacked deliveries per lane (run, control). */
    brokerPrefetch: number;
    /**
     * The Runtime Postgres pools. poolMax (RUNTIME_PG_POOL_MAX, 2..200, default 10) serves the stores and
     * DBOS steps; lockPoolMax (two lanes of prefetch, plus the maintenance lock) holds the PR locks, so a
     * lock holder never waits on its own pool for a second connection. connectionTimeoutMs
     * (RUNTIME_PG_CONNECTION_TIMEOUT_MS, 100..60000, default 5000): a wait for a connection fails instead of hanging.
     */
    pg: { poolMax: number; lockPoolMax: number; connectionTimeoutMs: number };
    /**
     * RUNTIME_EXECUTOR_ID, else DBOS__VMID: this replica's DBOS executor id, the owner a restart recovers
     * PENDING workflows for. Unique and stable per replica; required in production (DBOS defaults every
     * replica to the same 'local'). Unset outside production.
     */
    executorId?: string;
    admission: AdmissionLimits & { retryMs: number; leaseMs: number; attemptConcurrency: number; attemptPerOrg: number };
    /**
     * RUNTIME_SETUP_PER_ORG (1..8, default 2): environment setups of one org
     * that run at once on the setup queue; the next waits its turn. Cell
     * capacity is still guarded by admission and the capacity wait.
     */
    setupPerOrg: number;
    /**
     * RUNTIME_SETUP_CONCURRENCY (1..64, default 4, never above RUNTIME_GLOBAL_CONCURRENCY): setups
     * that run at once across the app. A setup builds and bakes on a cell at full size and may ask
     * the LLM for a recipe; it waits its turn on the setup queue, or as setup_limit under durable admission.
     */
    setupConcurrency: number;
    /**
     * RUNTIME_WORKER_CONCURRENCY (1..global, default min(10, RUNTIME_GLOBAL_CONCURRENCY)): Runs and
     * setups one replica runs at once, so one replica never takes every global slot while its
     * Postgres pool (RUNTIME_PG_POOL_MAX) serves a share of them.
     */
    workerConcurrency: number;
    /**
     * RUNTIME_ROUND_SNAPSHOTS (0 or 1, default 1): each Run side's acquire step also keeps the claim
     * as its round snapshot once ready, and the Run's resets restore it (RunDeps.roundSnapshots).
     */
    roundSnapshots: boolean;
    /**
     * RUNTIME_CAPACITY_WAIT_MAX_MS (0..1800000, default 1800000, 30 min): the longest a Run side waits
     * for room on a host (no free slot, no memory, the org's cap); past it the Run ends timed_out with
     * the no_capacity card. Never more than what is left of the Run's 30 min queue budget; 0: no wait.
     */
    capacityWaitMaxMs: number;
    /**
     * RUNTIME_QUEUE_TIMEOUT_MS (300000..14400000, default 1800000, 30 min): how long a Run may wait in
     * the queue (behind its org's RUNTIME_ORG_CONCURRENCY and RUNTIME_GLOBAL_CONCURRENCY) before it
     * ends timed_out. Raise it with the concurrency for bursts larger than an org's slots clear in it.
     */
    queueTimeoutMs: number;
    /**
     * RUNTIME_ISOLATION_MINIMUM (any | kernel | vm): the least isolation every Run and setup claim
     * asks (isolation-architecture.md C1); the hub places a claim only on a cell that satisfies it,
     * never lower. Default kernel in the production image (gVisor, a microVM or a VM: never the
     * dev-only local-docker driver), any elsewhere.
     */
    isolationMinimum: IsolationMinimum;
    /**
     * RUNTIME_DBOS_RETENTION_DAYS (8..3650, default 30): age past which the hourly retention deletes a terminal
     * DBOS workflow (shared/persistence/workflow-retention.ts). At least 8: a fork's gate waits 7 days for approval.
     */
    dbosRetentionDays: number;
    /**
     * RUNTIME_RUN_RETENTION_DAYS (30..3650, default 365): age past which the hourly retention deletes an ended Run's
     * projection row (`runtime_runs`) with its PR generation record, fork approval and preview record
     * (shared/persistence/runtime-schema.ts `applyRetention`). Never a Run still live, nor one a live claim, a kept
     * check or the stability history still names.
     */
    runRetentionDays: number;
    /**
     * RUNTIME_EXERCISED_LINES_THRESHOLD_PERCENT (0..100, default 50): the share of a Run's measured
     * changed lines that must run during the probes for a green Run to stay green; below it the Run
     * is partly tested (decideRunVerdict exercised). 0 never downgrades.
     */
    exercisedLinesThresholdPercent: number;
    /** RUNTIME_SECRET_SEAL_KEY: opens the repo and Run tokens inside the step that uses them. */
    secretSealKey: Buffer;
    git: { provider: 'github' | 'gitlab' | 'bitbucket' | 'azure_repos' | 'forgejo'; apiBase: string };
    llmFixturePath?: string;
    sweeper: boolean;
    dbosLogLevel: string;
    /**
     * Immutable worker release used by DBOS to select compatible workflow executions:
     * RUNTIME_RELEASE_VERSION, with PLANNER_WORKER_VERSION_SUFFIX appended on the worker planner host.
     */
    releaseVersion: string;
    /**
     * file: a local volume served by this worker's evidence server (dev, one replica).
     * s3: an S3-compatible bucket (RUNTIME_EVIDENCE_S3_*), cells upload by presigned URL; any replica.
     */
    evidence: { store: 'file' | 's3'; dir?: string; port?: number; secret?: string; uploadUrl?: string; s3?: S3EvidenceConfig };
    setup: SetupConfig;
    /** RUNTIME_ENV_SESSION_PORT: the env-session listener the API's /mcp/env tools call (off when unset). */
    envSessionPort?: number;
}

const file = (env: Env, name: string) => {
    const path = env[name];
    return path ? readFileSync(path, 'utf8') : undefined;
};

function required(env: Env, name: string, fallback?: string): string {
    const v = env[name] || fallback;
    if (v === undefined || v === '') throw new Error(`${name} is required`);
    return v;
}

function int(env: Env, name: string, fallback: number, min = 0): number {
    return requireEnvInt(name, env[name], fallback, min);
}

function boundedInt(env: Env, name: string, fallback: number, min: number, max: number): number {
    return requireEnvInt(name, env[name], fallback, min, max);
}

/** A malformed retry setting never reflects its environment value into boot logs. */
function retrySetting(env: Env, name: string, legacy: string, fallback: number, min: number, max: number): number {
    const value = envInteger(env[name] ?? env[legacy]);
    if (value === undefined) return fallback;
    if (value === null || !Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer between ${min} and ${max}`);
    return value;
}

function json<T>(env: Env, name: string, schema: z.ZodType<T>, fallback: T): T {
    const raw = env[name];
    if (!raw) return fallback;
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        throw new Error(`${name} must be JSON`);
    }
    const r = schema.safeParse(parsed);
    if (!r.success) throw new Error(`${name} is invalid: ${r.error.message}`);
    return r.data;
}

const CellTokens = z.record(z.string().min(1), z.strictObject({ token: z.string().min(12), owner: z.enum(['kodus', 'customer']), orgId: z.string().optional() }));

export const isProductionImage = (env: Env) => env.NODE_ENV === 'production' || env.RUNTIME_PRODUCTION_IMAGE === '1';

/** Development switches the production image refuses (the hub and the worker do not start). */
export function assertSafeForProduction(c: RuntimeConfig): void {
    if (!c.productionImage) return;
    // A process that serves TLS (the hub's listeners) trusts worker
    // certificates only from their own CA, never the cells' CA, and only
    // from the worker CNs it names.
    const servesTls = !!c.tls?.cert;
    const unsafe = [
        c.testOnlyPlaintext ? 'RUNTIME_TEST_ONLY_PLAINTEXT' : undefined,
        c.allowInsecureCells ? 'RUNTIME_DEV_ALLOW_INSECURE_CELLS' : undefined,
        c.envDriver === 'fake' ? 'RUNTIME_ENV_DRIVER=fake' : undefined,
        servesTls && !c.tls?.workerCa ? 'a missing RUNTIME_TLS_WORKER_CA' : undefined,
        servesTls && !c.workerAllowedCns.length ? 'an empty RUNTIME_WORKER_ALLOWED_CNS' : undefined,
    ].filter(Boolean);
    if (unsafe.length) throw new Error(`refused in the production image: ${unsafe.join(', ')}`);
}

export function loadRuntimeConfig(env: Env = process.env): RuntimeConfig {
    const admissionFlag = env.RUNTIME_DURABLE_ADMISSION ?? '0';
    if (!['0', '1', 'false', 'true'].includes(admissionFlag)) throw new Error('RUNTIME_DURABLE_ADMISSION must be 0, 1, false or true');
    const hubPort = int(env, 'RUNTIME_HUB_PORT', 3410, 1);
    const internalPort = int(env, 'RUNTIME_HUB_INTERNAL_PORT', hubPort + 1, 1);
    if (internalPort === hubPort) throw new Error('RUNTIME_HUB_INTERNAL_PORT must differ from RUNTIME_HUB_PORT');
    const plaintext = env.RUNTIME_TEST_ONLY_PLAINTEXT === '1';
    const internalToken = plaintext ? required(env, 'RUNTIME_INTERNAL_TOKEN') : undefined;
    if (internalToken !== undefined && internalToken.length < 16) throw new Error('RUNTIME_INTERNAL_TOKEN must have at least 16 characters');
    const config: RuntimeConfig = {
        durableAdmission: admissionFlag === '1' || admissionFlag === 'true',
        databaseUrl: required(env, 'RUNTIME_DATABASE_URL', 'postgres://runtime:runtime@localhost:5442/kodus_runtime'),
        rabbitUrl: required(env, 'RUNTIME_RABBITMQ_URL', 'amqp://guest:guest@localhost:5672'),
        streamDir: required(env, 'RUNTIME_STREAM_DIR', '/tmp/kody-runtime-streams'),
        streamStore: z.enum(['file', 'postgres']).parse(env.RUNTIME_STREAM_STORE || 'postgres'),
        tls: env.RUNTIME_TLS_CA
            ? {
                  ca: file(env, 'RUNTIME_TLS_CA')!,
                  caKey: file(env, 'RUNTIME_TLS_CA_KEY'),
                  cert: file(env, 'RUNTIME_TLS_CERT'),
                  key: file(env, 'RUNTIME_TLS_KEY'),
                  workerCa: file(env, 'RUNTIME_TLS_WORKER_CA'),
                  workerCert: file(env, 'RUNTIME_WORKER_TLS_CERT'),
                  workerKey: file(env, 'RUNTIME_WORKER_TLS_KEY'),
              }
            : undefined,
        workerAllowedCns: (env.RUNTIME_WORKER_ALLOWED_CNS ?? '')
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
        fleetAllowedCns: (env.RUNTIME_FLEET_ALLOWED_CNS ?? '')
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
        managedCells: json(env, 'RUNTIME_MANAGED_CELLS', z.record(z.string().min(1), z.string().min(1)), {}),
        allowInsecureCells: env.RUNTIME_DEV_ALLOW_INSECURE_CELLS === '1',
        testOnlyPlaintext: plaintext
            ? { internalToken: internalToken!, ...(env.RUNTIME_FLEET_INTERNAL_TOKEN ? { fleetToken: env.RUNTIME_FLEET_INTERNAL_TOKEN } : {}), cellTokens: json(env, 'RUNTIME_CELL_TOKENS', CellTokens, {}) }
            : undefined,
        hubUrl: required(env, 'RUNTIME_HUB_URL', `http://localhost:${internalPort}`),
        replicaId: required(env, 'RUNTIME_REPLICA_ID', `hub-${process.pid}`),
        replicaUrl: required(env, 'RUNTIME_REPLICA_URL', `http://localhost:${internalPort}`),
        hubPort,
        internalPort,
        metricsPort: env.RUNTIME_METRICS_PORT ? int(env, 'RUNTIME_METRICS_PORT', 0, 1) : undefined,
        envDriver: z.enum(['fake', 'hub']).parse(env.RUNTIME_ENV_DRIVER || 'hub'),
        partitionConcurrency: int(env, 'RUNTIME_ORG_CONCURRENCY', 2, 1),
        globalConcurrency: int(env, 'RUNTIME_GLOBAL_CONCURRENCY', 20, 1),
        orgSharedClaimCap: int(env, 'RUNTIME_ORG_SHARED_CLAIM_CAP', DEFAULT_ORG_SHARED_CLAIM_CAP, 1),
        machineMinutesPerOrgDay: int(env, 'RUNTIME_MACHINE_MINUTES_PER_ORG_DAY', DEFAULT_MACHINE_MINUTES_PER_ORG_DAY, 0),
        sandboxMemoryMb: boundedInt(env, 'RUNTIME_SANDBOX_MEMORY_MB', DEFAULT_SANDBOX_MEMORY_MB, MACHINE_SIZE_LIMITS.memoryMb.min, MACHINE_SIZE_LIMITS.memoryMb.max),
        productSecretsReadUrl: env.RUNTIME_PRODUCT_SECRETS_READ_URL || undefined,
        maxTokensPerRun: int(env, 'RUNTIME_MAX_TOKENS_PER_RUN', DEFAULT_MAX_TOKENS_PER_RUN, 1),
        llmGatewayUrl: env.RUNTIME_LLM_GATEWAY_URL || undefined,
        ...previewSettings(env),
        productionImage: isProductionImage(env),
    };
    const both = config.fleetAllowedCns.filter((cn) => config.workerAllowedCns.includes(cn));
    if (both.length) throw new Error(`RUNTIME_FLEET_ALLOWED_CNS and RUNTIME_WORKER_ALLOWED_CNS share ${both.join(', ')}: the fleet and the worker are different callers`);
    if (config.testOnlyPlaintext?.fleetToken !== undefined && (config.testOnlyPlaintext.fleetToken.length < 16 || config.testOnlyPlaintext.fleetToken === config.testOnlyPlaintext.internalToken)) {
        throw new Error('RUNTIME_FLEET_INTERNAL_TOKEN must have at least 16 characters and differ from RUNTIME_INTERNAL_TOKEN');
    }
    assertSafeForProduction(config);
    return config;
}

function previewSettings(env: Env): Pick<RuntimeConfig, 'previewDomain' | 'previewTunnelUrl'> {
    const domain = env.RUNTIME_PREVIEW_DOMAIN?.trim().toLowerCase();
    if (domain && !PreviewDomainSchema.safeParse(domain).success) throw new Error('RUNTIME_PREVIEW_DOMAIN must be a bare DNS name (no scheme, port or wildcard)');
    const tunnel = env.RUNTIME_PREVIEW_TUNNEL_URL?.trim();
    if (tunnel && !PREVIEW_TUNNEL_URL_PATTERN.test(tunnel)) throw new Error('RUNTIME_PREVIEW_TUNNEL_URL must be wss://<host>[:port]/v1/cells/tunnel');
    return { ...(domain ? { previewDomain: domain } : {}), ...(tunnel ? { previewTunnelUrl: tunnel } : {}) };
}

const GIT_PROVIDERS = ['github', 'gitlab', 'bitbucket', 'azure_repos', 'forgejo'] as const;

/** Validate the URL the cell will actually receive, without using a deployment secret. */
function evidenceUploadUrl(env: Env): string | undefined {
    const baseUrl = env.RUNTIME_EVIDENCE_UPLOAD_URL;
    if (!baseUrl) return undefined;
    try {
        const address = new URL(baseUrl);
        if (address.search || address.hash || address.username || address.password) {
            throw new Error('invalid evidence upload base');
        }
        const grant = signUploadGrant({
            baseUrl,
            organizationId: 'config-check',
            runId: 'config-check',
            side: 'base',
            stepId: '00000000-0000-4000-8000-000000000000',
            type: 'logs',
            secret: '0'.repeat(32), // Public sentinel: this grant is never issued or sent.
            nonce: 'configuration-check',
            ttlSeconds: 60,
            now: new Date('2000-01-01T00:00:00Z'),
        });
        if (UploadGrantSchema.safeParse(grant).success) return baseUrl;
    } catch { /* A URL/signing error must not reflect configuration values. */ }
    throw new Error('RUNTIME_EVIDENCE_UPLOAD_URL must produce a valid evidence upload grant');
}

/** A 0/1 switch, 0 when unset; anything else stops the process. */
function flag01(env: Env, name: string, dflt: '0' | '1' = '0'): boolean {
    const v = env[name] ?? dflt;
    if (v !== '0' && v !== '1') throw new Error(`${name} must be 0 or 1`);
    return v === '1';
}

/** The environment setup's settings (RUNTIME_SETUP_*), read once here and passed to the setup service. */
export interface SetupConfig {
    devSha?: string;
    devExposeJson?: string;
    healthPath?: string;
    /** RUNTIME_SETUP_AUTHOR_REPAIRS: how many times one setup rewrites Kody's recipe after its boot failed (0 turns it off). */
    authorRepairs: number;
}

export function loadSetupConfig(env: Env = process.env): SetupConfig {
    return {
        devSha: env.RUNTIME_SETUP_DEV_SHA?.trim() || undefined,
        devExposeJson: env.RUNTIME_SETUP_EXPOSE?.trim() || undefined,
        healthPath: env.RUNTIME_SETUP_HEALTH_PATH?.trim() || undefined,
        authorRepairs: boundedInt(env, 'RUNTIME_SETUP_AUTHOR_REPAIRS', SETUP_AUTHOR_REPAIRS_DEFAULT, 0, SETUP_AUTHOR_REPAIRS_MAX),
    };
}

/**
 * Appended to the DBOS application version of a worker that plans on the worker host. A
 * Run's steps differ by planner host, so a workflow never resumes on the other one; '+' is
 * outside RUNTIME_RELEASE_VERSION's alphabet, so no real release can collide with it.
 */
export const PLANNER_WORKER_VERSION_SUFFIX = '+planner-worker';

/** The DBOS application version of a release on a planner host: the release itself on the product host. */
export const workflowReleaseOf = (release: string, plannerHost: WorkerConfig['plannerHost']) =>
    plannerHost === 'worker' ? `${release}${PLANNER_WORKER_VERSION_SUFFIX}` : release;

/** Every replica on DBOS's default 'local' would recover the PENDING workflows of the live ones. */
function executorIdOf(env: Env, productionImage: boolean): string | undefined {
    const own = env.RUNTIME_EXECUTOR_ID || undefined;
    const vmid = env.DBOS__VMID || undefined;
    if (own && vmid && own !== vmid) throw new Error('RUNTIME_EXECUTOR_ID and DBOS__VMID disagree; set one of them');
    const id = own ?? vmid;
    if (!id) {
        if (productionImage) throw new Error('RUNTIME_EXECUTOR_ID (or DBOS__VMID) is required in production: a unique, stable id per worker replica');
        return undefined;
    }
    if (id === 'local' || id.length > 128 || !/^[A-Za-z0-9]/.test(id) || /[^A-Za-z0-9._-]/.test(id)) {
        throw new Error("RUNTIME_EXECUTOR_ID must be 1-128 letters, digits, dots, underscores or hyphens, starting with a letter or digit, and not 'local'");
    }
    return id;
}

export function loadWorkerConfig(env: Env = process.env): WorkerConfig {
    const base = loadRuntimeConfig(env);
    if (base.durableAdmission && env.RUNTIME_SWEEPER === 'false') throw new Error('RUNTIME_DURABLE_ADMISSION requires RUNTIME_SWEEPER for durable repair');
    const releaseVersion = env.RUNTIME_RELEASE_VERSION ?? (base.productionImage ? undefined : 'development');
    if (!releaseVersion || releaseVersion.length > 128 || !/^[A-Za-z0-9]/.test(releaseVersion) || /[^A-Za-z0-9._-]/.test(releaseVersion)) {
        throw new Error('RUNTIME_RELEASE_VERSION is required in production and must be 1-128 letters, digits, dots, underscores or hyphens, starting with a letter or digit');
    }
    const plannerHost = z.enum(['product', 'worker']).parse(env.RUNTIME_PLANNER_HOST || 'product');
    if (plannerHost === 'worker' && !base.llmGatewayUrl) {
        throw new Error('RUNTIME_PLANNER_HOST=worker requires RUNTIME_LLM_GATEWAY_URL, the product gateway the worker planner calls');
    }
    let secretSealKey: Buffer;
    try {
        secretSealKey = sealingKeyFrom(env.RUNTIME_SECRET_SEAL_KEY);
    } catch (e) {
        throw new Error(`RUNTIME_SECRET_SEAL_KEY is required: ${(e as Error).message}`, { cause: e });
    }
    // The dev key is in the repo (and in the dev composes): a production
    // worker opening tokens with it would let anyone read them.
    if (base.productionImage && secretSealKey.equals(devSealKey())) {
        throw new Error('RUNTIME_SECRET_SEAL_KEY is the dev-only seal key; the production image needs its own');
    }
    // The evidence secret the API signs URLs with: never the dev composes' value either.
    assertProductionSecret('RUNTIME_EVIDENCE_SIGNING_SECRET', env.RUNTIME_EVIDENCE_SIGNING_SECRET, base.productionImage);
    const evidencePort = env.RUNTIME_EVIDENCE_PORT ? int(env, 'RUNTIME_EVIDENCE_PORT', 0, 1) : undefined;
    const evidenceStore = z.enum(['file', 's3']).parse(env.RUNTIME_EVIDENCE_STORE || 'file');
    const brokerRetryDelayMs = retrySetting(env, 'RUNTIME_COMMAND_RETRY_DELAY_MS', 'WORKFLOW_QUEUE_WORKER_RETRY_DELAY_MS', 1000, 1, 60_000);
    const brokerPrefetch = boundedInt(env, 'RUNTIME_BROKER_PREFETCH', 10, 1, 100);
    const setupConcurrency = Math.min(boundedInt(env, 'RUNTIME_SETUP_CONCURRENCY', 4, 1, 64), base.globalConcurrency);
    const queueTimeoutMs = boundedInt(env, 'RUNTIME_QUEUE_TIMEOUT_MS', 30 * 60_000, 5 * 60_000, 4 * 60 * 60_000);
    const isolationMinimum = IsolationMinimumSchema.parse(env.RUNTIME_ISOLATION_MINIMUM || (base.productionImage ? 'kernel' : 'any'));
    const executorId = executorIdOf(env, base.productionImage);
    return {
        ...base,
        brokerPrefetch,
        pg: {
            poolMax: boundedInt(env, 'RUNTIME_PG_POOL_MAX', 10, 2, 200),
            lockPoolMax: 2 * brokerPrefetch + 1,
            connectionTimeoutMs: boundedInt(env, 'RUNTIME_PG_CONNECTION_TIMEOUT_MS', 5000, 100, 60_000),
        },
        ...(executorId ? { executorId } : {}),
        brokerRetry: {
            maxRetries: retrySetting(env, 'RUNTIME_COMMAND_MAX_RETRIES', 'WORKFLOW_QUEUE_WORKER_MAX_RETRIES', 5, 0, 10),
            delayMs: brokerRetryDelayMs,
            maxDelayMs: Math.max(30_000, brokerRetryDelayMs),
        },
        admission: {
            globalWaiting: boundedInt(env, 'RUNTIME_ADMISSION_GLOBAL_WAITING', 1000, 1, 10_000),
            perOrgWaiting: boundedInt(env, 'RUNTIME_ADMISSION_ORG_WAITING', 100, 1, 10_000),
            globalExecuting: base.globalConcurrency,
            perOrgExecuting: Math.min(base.partitionConcurrency, base.globalConcurrency),
            maxAttempts: boundedInt(env, 'RUNTIME_ADMISSION_MAX_ATTEMPTS', 360, 1, 3600),
            maxPayloadBytes: boundedInt(env, 'RUNTIME_ADMISSION_MAX_PAYLOAD_BYTES', ADMISSION_BYTE_LIMITS.maxPayloadBytes, 1024, 64 * 1024 * 1024),
            globalBacklogBytes: boundedInt(env, 'RUNTIME_ADMISSION_GLOBAL_BACKLOG_BYTES', ADMISSION_BYTE_LIMITS.globalBacklogBytes, 1024, 1024 * 1024 * 1024),
            orgBacklogBytes: boundedInt(env, 'RUNTIME_ADMISSION_ORG_BACKLOG_BYTES', ADMISSION_BYTE_LIMITS.orgBacklogBytes, 1024, 1024 * 1024 * 1024),
            attemptConcurrency: boundedInt(env, 'RUNTIME_ADMISSION_ATTEMPT_CONCURRENCY', 8, 1, 128),
            attemptPerOrg: boundedInt(env, 'RUNTIME_ADMISSION_ATTEMPT_ORG_CONCURRENCY', 1, 1, 16),
            globalSetups: setupConcurrency,
            retryMs: boundedInt(env, 'RUNTIME_ADMISSION_RETRY_MS', 5000, 100, 60_000),
            leaseMs: boundedInt(env, 'RUNTIME_ADMISSION_LEASE_MS', 30_000, 30_000, 120_000),
            // A durable request waits for its execution as long as a Run waits in the queue.
            waitMs: queueTimeoutMs,
        },
        setupPerOrg: boundedInt(env, 'RUNTIME_SETUP_PER_ORG', 2, 1, 8),
        setupConcurrency,
        workerConcurrency: boundedInt(env, 'RUNTIME_WORKER_CONCURRENCY', Math.min(10, base.globalConcurrency), 1, base.globalConcurrency),
        roundSnapshots: flag01(env, 'RUNTIME_ROUND_SNAPSHOTS', '1'),
        capacityWaitMaxMs: boundedInt(env, 'RUNTIME_CAPACITY_WAIT_MAX_MS', 30 * 60_000, 0, 30 * 60_000),
        queueTimeoutMs,
        isolationMinimum,
        dbosRetentionDays: boundedInt(env, 'RUNTIME_DBOS_RETENTION_DAYS', 30, 8, 3650),
        runRetentionDays: boundedInt(env, 'RUNTIME_RUN_RETENTION_DAYS', 365, 30, 3650),
        exercisedLinesThresholdPercent: boundedInt(env, 'RUNTIME_EXERCISED_LINES_THRESHOLD_PERCENT', DEFAULT_EXERCISED_LINES_THRESHOLD_PERCENT, 0, 100),
        secretSealKey,
        git: {
            provider: z.enum(GIT_PROVIDERS).parse(env.RUNTIME_GIT_PROVIDER || 'github'),
            apiBase: z.url().parse(env.RUNTIME_GIT_API_BASE || 'https://api.github.com'),
        },
        llmFixturePath: env.RUNTIME_LLM_FIXTURE || undefined,
        plannerHost,
        sweeper: env.RUNTIME_SWEEPER !== 'false',
        dbosLogLevel: env.DBOS_LOG_LEVEL || 'warn',
        releaseVersion: workflowReleaseOf(releaseVersion, plannerHost),
        evidence: {
            store: evidenceStore,
            ...(evidenceStore === 's3' ? { s3: loadS3EvidenceConfig(env) } : {}),
            dir: env.RUNTIME_EVIDENCE_DIR || undefined,
            port: evidencePort,
            secret: env.RUNTIME_EVIDENCE_SIGNING_SECRET || undefined,
            uploadUrl: evidenceUploadUrl(env),
        },
        setup: loadSetupConfig(env),
        ...(env.RUNTIME_ENV_SESSION_PORT ? { envSessionPort: int(env, 'RUNTIME_ENV_SESSION_PORT', 0, 1) } : {}),
    };
}

/** runtime-fleet (docs/runtime/host-providers.md §4.1): the only process that holds a provider credential. */
export interface FleetConfig extends RuntimeConfig {
    /** The DBOS application version of the host workflows (RUNTIME_RELEASE_VERSION, as the worker's). */
    releaseVersion: string;
    executorId?: string;
    dbosLogLevel: string;
    /** The fleet's own DBOS system database (RUNTIME_FLEET_SYSTEM_DATABASE_URL; default the Runtime database's name + `_fleet`). */
    systemDatabaseUrl: string;
    /** The tag every host of this installation carries (RUNTIME_FLEET_INSTALLATION); the orphan pass lists by it. */
    installation: string;
    /** What a new host enrolls with: the hub's public URL (RUNTIME_FLEET_HUB_PUBLIC_URL) and its CA (RUNTIME_TLS_CA). */
    hubPublicUrl: string;
    hubCa: string;
    reconcileIntervalMs: number;
    /** Seals the fleet token inside the host workflow's step outputs (RUNTIME_SECRET_SEAL_KEY). */
    secretSealKey: Buffer;
    /** boat (RUNTIME_BOAT_API_KEY, RUNTIME_BOAT_API_URL): absent, no boat pool is scalable. */
    boat?: { apiUrl: string; apiKey: string };
    /** Dev only (RUNTIME_FLEET_FAKE_PROVIDER=1): the in-process fake provider for `fake` pools. Refused in production. */
    fakeProvider: boolean;
}

export function loadFleetConfig(env: Env = process.env): FleetConfig {
    const base = loadRuntimeConfig(env);
    const releaseVersion = env.RUNTIME_RELEASE_VERSION ?? (base.productionImage ? undefined : 'development');
    if (!releaseVersion || releaseVersion.length > 128 || !/^[A-Za-z0-9]/.test(releaseVersion) || /[^A-Za-z0-9._-]/.test(releaseVersion)) {
        throw new Error('RUNTIME_RELEASE_VERSION is required in production and must be 1-128 letters, digits, dots, underscores or hyphens, starting with a letter or digit');
    }
    let secretSealKey: Buffer;
    try {
        secretSealKey = sealingKeyFrom(env.RUNTIME_SECRET_SEAL_KEY);
    } catch (e) {
        throw new Error(`RUNTIME_SECRET_SEAL_KEY is required: ${(e as Error).message}`, { cause: e });
    }
    if (base.productionImage && secretSealKey.equals(devSealKey())) throw new Error('RUNTIME_SECRET_SEAL_KEY is the dev-only seal key; the production image needs its own');
    const installation = env.RUNTIME_FLEET_INSTALLATION || (base.productionImage ? '' : 'dev');
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(installation)) throw new Error('RUNTIME_FLEET_INSTALLATION is required in production: a lowercase slug of at most 63 characters');
    const hubPublicUrl = env.RUNTIME_FLEET_HUB_PUBLIC_URL || (base.productionImage ? '' : `https://localhost:${base.hubPort}`);
    if (!/^https:\/\/[^/\s]+$/.test(hubPublicUrl)) throw new Error('RUNTIME_FLEET_HUB_PUBLIC_URL must be the https://host:port cells register at');
    const fakeProvider = flag01(env, 'RUNTIME_FLEET_FAKE_PROVIDER');
    if (fakeProvider && base.productionImage) throw new Error('refused in the production image: RUNTIME_FLEET_FAKE_PROVIDER');
    const boatKey = env.RUNTIME_BOAT_API_KEY || undefined;
    const systemDatabaseUrl = env.RUNTIME_FLEET_SYSTEM_DATABASE_URL || fleetSystemDatabaseOf(base.databaseUrl);
    if (systemDatabaseUrl === base.databaseUrl) throw new Error('RUNTIME_FLEET_SYSTEM_DATABASE_URL must differ from RUNTIME_DATABASE_URL: the fleet has its own DBOS application');
    if (base.productionImage && !(base.tls?.ca && base.tls.workerCert && base.tls.workerKey)) {
        throw new Error('the production fleet needs RUNTIME_TLS_CA (the hub CA new hosts pin) and its client certificate (RUNTIME_WORKER_TLS_CERT, RUNTIME_WORKER_TLS_KEY, CN in RUNTIME_FLEET_ALLOWED_CNS)');
    }
    return {
        ...base,
        releaseVersion,
        executorId: executorIdOf(env, base.productionImage),
        dbosLogLevel: env.DBOS_LOG_LEVEL || 'warn',
        systemDatabaseUrl,
        installation,
        hubPublicUrl,
        hubCa: base.tls?.ca ?? '',
        reconcileIntervalMs: boundedInt(env, 'RUNTIME_FLEET_RECONCILE_MS', 15_000, 1_000, 300_000),
        secretSealKey,
        ...(boatKey ? { boat: { apiKey: boatKey, apiUrl: env.RUNTIME_BOAT_API_URL || 'https://boat.dev/api/v1' } } : {}),
        fakeProvider,
    };
}

/**
 * `runtime-fleet apply` (docs/runtime/host-providers.md §5.2): only the Runtime database. It holds no provider
 * key, hub certificate or seal key, so the deploy pipeline that runs it needs nothing else.
 */
export interface FleetApplyConfig {
    databaseUrl: string;
    /** `fake` pools are accepted only outside the production image, with RUNTIME_FLEET_FAKE_PROVIDER=1. */
    allowFake: boolean;
}

export function loadFleetApplyConfig(env: Env = process.env): FleetApplyConfig {
    const productionImage = isProductionImage(env);
    const databaseUrl = required(env, 'RUNTIME_DATABASE_URL', productionImage ? undefined : 'postgres://runtime:runtime@localhost:5442/kodus_runtime');
    const allowFake = flag01(env, 'RUNTIME_FLEET_FAKE_PROVIDER');
    if (allowFake && productionImage) throw new Error('refused in the production image: RUNTIME_FLEET_FAKE_PROVIDER');
    return { databaseUrl, allowFake };
}

/** The Runtime database URL with `_fleet` after its name: the fleet's DBOS system database by default. */
export function fleetSystemDatabaseOf(databaseUrl: string): string {
    const u = new URL(databaseUrl);
    u.pathname = `/${u.pathname.slice(1) || 'kodus_runtime'}_fleet`;
    return u.toString();
}

export const RUNTIME_CONFIG = Symbol('RUNTIME_CONFIG');
export const RUNTIME_PG_POOL = Symbol('RUNTIME_PG_POOL');
export const COMMAND_STORE = Symbol('COMMAND_STORE');
/** runtime.runtime_runs, the Run projection the worker writes from its DBOS steps. */
export const RUNTIME_RUN_PROJECTION_STORE = Symbol('RUNTIME_RUN_PROJECTION_STORE');

/**
 * The preview edge (docs/runtime/preview-urls.md §4): its own process
 * (`runtime-preview-edge`), two listeners. The browser listener serves
 * *.RUNTIME_PREVIEW_DOMAIN with the wildcard certificate (or plain HTTP behind
 * a load balancer that terminates TLS, RUNTIME_PREVIEW_TLS_UPSTREAM=1); the
 * tunnel listener takes the cells' WebSockets with mTLS against the cell CA
 * (RUNTIME_TLS_CA), never behind a TLS-terminating balancer.
 */
export interface PreviewEdgeConfig {
    databaseUrl: string;
    replicaId: string;
    domain: string;
    /** The web app's origin (RUNTIME_PREVIEW_APP_URL), for links back and the same-site check. */
    appUrl: string;
    grantPublicKey: string;
    port: number;
    /** PEM of the wildcard certificate and key; absent only with tlsUpstream. */
    tls?: { cert: string; key: string };
    tlsUpstream: boolean;
    tunnelPort: number;
    tunnelTls: { cert: string; key: string; cellCa: string };
    /** RUNTIME_PREVIEW_EDGE_INTERNAL_URL: this replica's browser listener as the other replicas reach it; absent, one replica (§4.2). */
    internalUrl?: string;
    /** RUNTIME_PREVIEW_SESSION_REVALIDATE_MINUTES: a session older than this goes back to the app for a fresh grant (default 15, at most the 12 h session). */
    sessionRevalidateMinutes?: number;
    metricsPort?: number;
    productionImage: boolean;
}

/**
 * The grant's public key as the PEM itself, the base64 of the PEM, or the
 * base64 of its SPKI DER (the API's RUNTIME_PREVIEW_GRANT_PRIVATE_KEY takes
 * PKCS8 the same ways); returned as PEM.
 */
function publicKeyPemOf(name: string, raw: string): string {
    const v = raw.trim().replace(/\\n/g, '\n');
    if (v.startsWith('-----BEGIN')) return v;
    const bytes = Buffer.from(v, 'base64');
    const text = bytes.toString('utf8').trim();
    if (text.startsWith('-----BEGIN')) return text;
    try {
        return createPublicKey({ key: bytes, format: 'der', type: 'spki' }).export({ type: 'spki', format: 'pem' }).toString();
    } catch {
        throw new Error(`${name} must be a PEM, the base64 of one, or the base64 of an SPKI DER key`);
    }
}

/** An http(s) origin with no path, query or credentials: the replica's own browser listener. */
function internalUrlOf(env: Env): { internalUrl?: string } {
    const raw = env.RUNTIME_PREVIEW_EDGE_INTERNAL_URL?.trim();
    if (!raw) return {};
    let u: URL;
    try {
        u = new URL(raw);
    } catch {
        throw new Error('RUNTIME_PREVIEW_EDGE_INTERNAL_URL must be a URL');
    }
    if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.username || u.password || (u.pathname !== '/' && u.pathname !== '') || u.search || u.hash) {
        throw new Error('RUNTIME_PREVIEW_EDGE_INTERNAL_URL must be an http(s) origin such as http://10.0.1.5:3430, with no path');
    }
    return { internalUrl: u.origin };
}

export function loadPreviewEdgeConfig(env: Env = process.env): PreviewEdgeConfig {
    const { previewDomain } = previewSettings(env);
    if (!previewDomain) throw new Error('RUNTIME_PREVIEW_DOMAIN is required: the preview edge serves nothing without its own domain');
    const appUrl = required(env, 'RUNTIME_PREVIEW_APP_URL');
    let appHost: string;
    try {
        appHost = new URL(appUrl).hostname;
    } catch {
        throw new Error('RUNTIME_PREVIEW_APP_URL must be a URL');
    }
    if (isSameSite(previewDomain, appHost) && env.RUNTIME_PREVIEW_ALLOW_SAME_SITE !== 'true') {
        throw new Error('RUNTIME_PREVIEW_DOMAIN is the same site as the web app: a preview could set its cookies. Use another registrable domain (or RUNTIME_PREVIEW_ALLOW_SAME_SITE=true to accept that risk; no screen warns about it yet)');
    }
    const tlsUpstream = env.RUNTIME_PREVIEW_TLS_UPSTREAM === '1';
    const cert = file(env, 'RUNTIME_PREVIEW_TLS_CERT');
    const key = file(env, 'RUNTIME_PREVIEW_TLS_KEY');
    if (!tlsUpstream && (!cert || !key)) throw new Error('RUNTIME_PREVIEW_TLS_CERT and RUNTIME_PREVIEW_TLS_KEY are required unless RUNTIME_PREVIEW_TLS_UPSTREAM=1');
    const tunnelCert = file(env, 'RUNTIME_PREVIEW_TUNNEL_TLS_CERT');
    const tunnelKey = file(env, 'RUNTIME_PREVIEW_TUNNEL_TLS_KEY');
    const cellCa = file(env, 'RUNTIME_TLS_CA');
    if (!tunnelCert || !tunnelKey || !cellCa) throw new Error('RUNTIME_PREVIEW_TUNNEL_TLS_CERT, RUNTIME_PREVIEW_TUNNEL_TLS_KEY and RUNTIME_TLS_CA are required: cells dial the edge with mTLS');
    return {
        databaseUrl: required(env, 'RUNTIME_DATABASE_URL', 'postgres://runtime:runtime@localhost:5442/kodus_runtime'),
        replicaId: required(env, 'RUNTIME_REPLICA_ID', `edge-${process.pid}`),
        domain: previewDomain,
        appUrl: appUrl.replace(/\/+$/, ''),
        grantPublicKey: publicKeyPemOf('RUNTIME_PREVIEW_GRANT_PUBLIC_KEY', required(env, 'RUNTIME_PREVIEW_GRANT_PUBLIC_KEY')),
        port: int(env, 'RUNTIME_PREVIEW_EDGE_PORT', 3430, 1),
        ...(cert && key ? { tls: { cert, key } } : {}),
        tlsUpstream,
        tunnelPort: int(env, 'RUNTIME_PREVIEW_TUNNEL_PORT', 3431, 1),
        tunnelTls: { cert: tunnelCert, key: tunnelKey, cellCa },
        ...internalUrlOf(env),
        sessionRevalidateMinutes: boundedInt(env, 'RUNTIME_PREVIEW_SESSION_REVALIDATE_MINUTES', PREVIEW_SESSION_REVALIDATE_MINUTES, 1, PREVIEW_SESSION_MAX_HOURS * 60),
        metricsPort: env.RUNTIME_METRICS_PORT ? int(env, 'RUNTIME_METRICS_PORT', 0, 1) : undefined,
        productionImage: isProductionImage(env),
    };
}
