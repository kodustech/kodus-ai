import { readFileSync } from 'fs';

import { z } from 'zod';

import { loadS3EvidenceConfig, type S3EvidenceConfig } from '@libs/runtime/contracts/evidence-s3';
import { sealingKeyFrom } from '@libs/runtime/run';
import { signUploadGrant } from '@libs/runtime/contracts/evidence';
import { UploadGrantSchema } from '@libs/runtime/protocol/messages';

import { DEFAULT_ORG_SHARED_CLAIM_CAP } from './persistence/cell-directory';
import { ADMISSION_BYTE_LIMITS, type AdmissionLimits } from './admission/admission-contract';

// Runtime configuration, read and validated once at boot (fail fast). The
// Runtime has its own Postgres database, its own broker user and no Git or
// LLM credential (ADR-025, ADR-052, ADR-057). Nothing else in apps/runtime
// reads the process environment.

export type Env = Record<string, string | undefined>;

export interface RuntimeConfig {
    /** Opt-in durable admission; enable on both hub and worker after release validation. */
    durableAdmission: boolean;
    databaseUrl: string;
    rabbitUrl: string;
    mongoUrl?: string;
    mongoDb: string;
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
    /** Managed cells (cellId → serial of their CA-signed certificate) that get a runtime_cells row at boot. */
    managedCells: Record<string, string>;
    allowInsecureCells: boolean;
    /**
     * TEST ONLY (RUNTIME_TEST_ONLY_PLAINTEXT=1): plain HTTP, cells by shared
     * token and the worker by bearer token, for the docker e2e with the TS
     * fake cell. Refused in the production image and without explicit tokens.
     */
    testOnlyPlaintext?: { internalToken: string; cellTokens: Record<string, { token: string; owner: 'kodus' | 'customer'; orgId?: string }> };
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
    maxTokensPerRun: number;
    /** Product API base URL of the LLM gateway (RUNTIME_LLM_GATEWAY_URL); unset → recorded responses. */
    llmGatewayUrl?: string;
    /** True in the production image (NODE_ENV=production or RUNTIME_PRODUCTION_IMAGE=1). */
    productionImage: boolean;
}

export interface WorkerConfig extends RuntimeConfig {
    /** Stage only: switch with a new immutable release and zero active old-host Runs. */
    plannerHost: 'product' | 'worker';
    /** Bounded broker retries before durable Run/setup admission; independent of workflow execution. */
    brokerRetry: { maxRetries: number; delayMs: number; maxDelayMs: number };
    admission: AdmissionLimits & { retryMs: number; leaseMs: number; attemptConcurrency: number; attemptPerOrg: number };
    /** RUNTIME_SECRET_SEAL_KEY: opens the repo and Run tokens inside the step that uses them. */
    secretSealKey: Buffer;
    git: { provider: 'github' | 'gitlab' | 'bitbucket' | 'azure_repos' | 'forgejo'; apiBase: string };
    llmFixturePath?: string;
    sweeper: boolean;
    dbosLogLevel: string;
    /** Immutable worker release used by DBOS to select compatible workflow executions. */
    releaseVersion: string;
    /**
     * file: a local volume served by this worker's evidence server (dev, one replica).
     * s3: an S3-compatible bucket (RUNTIME_EVIDENCE_S3_*), cells upload by presigned URL; any replica.
     */
    evidence: { store: 'file' | 's3'; dir?: string; port?: number; secret?: string; uploadUrl?: string; s3?: S3EvidenceConfig };
    setup: { devSha?: string; devExposeJson?: string; healthPath?: string };
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
    const raw = env[name];
    if (raw === undefined || raw === '') return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min) throw new Error(`${name} must be an integer >= ${min} (got ${JSON.stringify(raw)})`);
    return n;
}

function boundedInt(env: Env, name: string, fallback: number, min: number, max: number): number {
    const value = int(env, name, fallback, min);
    if (value > max) throw new Error(`${name} must be <= ${max}`);
    return value;
}

/** A malformed retry setting never reflects its environment value into boot logs. */
function retrySetting(env: Env, name: string, legacy: string, fallback: number, min: number, max: number): number {
    const raw = env[name] ?? env[legacy];
    if (raw === undefined || raw === '') return fallback;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer between ${min} and ${max}`);
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
    const unsafe = [
        c.testOnlyPlaintext ? 'RUNTIME_TEST_ONLY_PLAINTEXT' : undefined,
        c.allowInsecureCells ? 'RUNTIME_DEV_ALLOW_INSECURE_CELLS' : undefined,
        c.envDriver === 'fake' ? 'RUNTIME_ENV_DRIVER=fake' : undefined,
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
        mongoUrl: env.RUNTIME_MONGO_URL || undefined,
        mongoDb: required(env, 'RUNTIME_MONGO_DB', 'kodus'),
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
        managedCells: json(env, 'RUNTIME_MANAGED_CELLS', z.record(z.string().min(1), z.string().min(1)), {}),
        allowInsecureCells: env.RUNTIME_DEV_ALLOW_INSECURE_CELLS === '1',
        testOnlyPlaintext: plaintext ? { internalToken: internalToken!, cellTokens: json(env, 'RUNTIME_CELL_TOKENS', CellTokens, {}) } : undefined,
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
        maxTokensPerRun: int(env, 'RUNTIME_MAX_TOKENS_PER_RUN', 200_000, 1),
        llmGatewayUrl: env.RUNTIME_LLM_GATEWAY_URL || undefined,
        productionImage: isProductionImage(env),
    };
    assertSafeForProduction(config);
    return config;
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

export function loadWorkerConfig(env: Env = process.env): WorkerConfig {
    const base = loadRuntimeConfig(env);
    if (base.durableAdmission && env.RUNTIME_SWEEPER === 'false') throw new Error('RUNTIME_DURABLE_ADMISSION requires RUNTIME_SWEEPER for durable repair');
    const releaseVersion = env.RUNTIME_RELEASE_VERSION ?? (base.productionImage ? undefined : 'development');
    if (!releaseVersion || releaseVersion.length > 128 || !/^[A-Za-z0-9]/.test(releaseVersion) || /[^A-Za-z0-9._-]/.test(releaseVersion)) {
        throw new Error('RUNTIME_RELEASE_VERSION is required in production and must be 1-128 letters, digits, dots, underscores or hyphens, starting with a letter or digit');
    }
    const plannerHost = z.enum(['product', 'worker']).parse(env.RUNTIME_PLANNER_HOST || 'product');
    if (plannerHost === 'worker' && (!base.llmGatewayUrl || !releaseVersion.endsWith('-planner-worker-v1'))) {
        throw new Error('Worker planner requires a product gateway and an immutable release ending -planner-worker-v1');
    }
    let secretSealKey: Buffer;
    try {
        secretSealKey = sealingKeyFrom(env.RUNTIME_SECRET_SEAL_KEY);
    } catch (e) {
        throw new Error(`RUNTIME_SECRET_SEAL_KEY is required: ${(e as Error).message}`, { cause: e });
    }
    const evidencePort = env.RUNTIME_EVIDENCE_PORT ? int(env, 'RUNTIME_EVIDENCE_PORT', 0, 1) : undefined;
    const evidenceStore = z.enum(['file', 's3']).parse(env.RUNTIME_EVIDENCE_STORE || 'file');
    const brokerRetryDelayMs = retrySetting(env, 'RUNTIME_COMMAND_RETRY_DELAY_MS', 'WORKFLOW_QUEUE_WORKER_RETRY_DELAY_MS', 1000, 1, 60_000);
    return {
        ...base,
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
            retryMs: boundedInt(env, 'RUNTIME_ADMISSION_RETRY_MS', 5000, 100, 60_000),
            leaseMs: boundedInt(env, 'RUNTIME_ADMISSION_LEASE_MS', 30_000, 30_000, 120_000),
        },
        secretSealKey,
        git: {
            provider: z.enum(GIT_PROVIDERS).parse(env.RUNTIME_GIT_PROVIDER || 'github'),
            apiBase: z.url().parse(env.RUNTIME_GIT_API_BASE || 'https://api.github.com'),
        },
        llmFixturePath: env.RUNTIME_LLM_FIXTURE || undefined,
        plannerHost,
        sweeper: env.RUNTIME_SWEEPER !== 'false',
        dbosLogLevel: env.DBOS_LOG_LEVEL || 'warn',
        releaseVersion,
        evidence: {
            store: evidenceStore,
            ...(evidenceStore === 's3' ? { s3: loadS3EvidenceConfig(env) } : {}),
            dir: env.RUNTIME_EVIDENCE_DIR || undefined,
            port: evidencePort,
            secret: env.RUNTIME_EVIDENCE_SIGNING_SECRET || undefined,
            uploadUrl: evidenceUploadUrl(env),
        },
        setup: {
            devSha: env.RUNTIME_SETUP_DEV_SHA?.trim() || undefined,
            devExposeJson: env.RUNTIME_SETUP_EXPOSE?.trim() || undefined,
            healthPath: env.RUNTIME_SETUP_HEALTH_PATH?.trim() || undefined,
        },
        ...(env.RUNTIME_ENV_SESSION_PORT ? { envSessionPort: int(env, 'RUNTIME_ENV_SESSION_PORT', 0, 1) } : {}),
    };
}

export const RUNTIME_CONFIG = Symbol('RUNTIME_CONFIG');
export const RUNTIME_PG_POOL = Symbol('RUNTIME_PG_POOL');
export const COMMAND_STORE = Symbol('COMMAND_STORE');
