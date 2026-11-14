import { loadS3EvidenceConfig } from '@libs/runtime/contracts/evidence-s3';
import { isMachineSizePreset } from '@libs/runtime/contracts/machine-size';

import { parseDenylist } from '../domain/egress';
import { CELL_HOST_LIST_PRICES, type CellHostPrice } from '../domain/run-cost';
import type { RuntimeApiConfig } from '../domain/ports';

const atLeastZero = (value: string | undefined, fallback: number) => {
    const n = Number(value);
    return value !== undefined && value !== '' && Number.isInteger(n) && n >= 0 ? n : fallback;
};

const int = (value: string | undefined, fallback: number) => {
    const n = Number(value);
    return Number.isInteger(n) && n > 0 ? n : fallback;
};

/** Runtime settings of the API, from the environment (RUNTIME_* names, shared with apps/runtime where they overlap). */
export function loadRuntimeApiConfig(env: NodeJS.ProcessEnv = process.env): RuntimeApiConfig {
    const evidenceStore = env.RUNTIME_EVIDENCE_STORE === 's3' ? 's3' : 'file';
    return {
        a2aBaseUrl: env.RUNTIME_A2A_BASE_URL || undefined,
        runTokenSecret: env.RUNTIME_RUN_TOKEN_SECRET || undefined,
        evidenceSigningSecret: env.RUNTIME_EVIDENCE_SIGNING_SECRET || undefined,
        evidenceBaseUrl: env.RUNTIME_EVIDENCE_BASE_URL || undefined,
        evidenceTtlSeconds: Math.min(int(env.RUNTIME_EVIDENCE_URL_TTL_SECONDS, 300), 300),
        evidenceStore,
        // Only GetObject is needed here (the API signs reads, never writes); a bad value stops the boot.
        ...(evidenceStore === 's3' ? { evidenceS3: loadS3EvidenceConfig(env) } : {}),
        llmBudget: {
            perRun: int(env.RUNTIME_LLM_MAX_TOKENS_PER_RUN ?? env.RUNTIME_MAX_TOKENS_PER_RUN, 200_000),
            perPullRequest: int(env.RUNTIME_LLM_MAX_TOKENS_PER_PR, 600_000),
            perOrgPerDay: int(env.RUNTIME_LLM_MAX_TOKENS_PER_ORG_DAY, 5_000_000),
        },
        // Off unless the deployment's plan sets a default; an admin may go up to the ceiling.
        pool: (() => {
            const maxSize = atLeastZero(env.RUNTIME_POOL_MAX_SIZE, 4);
            return { defaultSize: Math.min(atLeastZero(env.RUNTIME_POOL_DEFAULT_SIZE, 0), maxSize), maxSize };
        })(),
        // Every preset unless the deployment's plan lowers it, as the pool's ceiling (4) is open by default.
        machineSize: { maxPreset: isMachineSizePreset(env.RUNTIME_MACHINE_SIZE_MAX) ? env.RUNTIME_MACHINE_SIZE_MAX : 'large' },
        oncallUserIds: (env.RUNTIME_ONCALL_USER_IDS ?? '')
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
        egressDenylist: parseDenylist(env.RUNTIME_EGRESS_DENYLIST),
        streamLongPollMs: int(env.RUNTIME_STREAM_LONG_POLL_MS, 20_000),
        streamPollIntervalMs: int(env.RUNTIME_STREAM_POLL_INTERVAL_MS, 500),
        secretSealKey: env.RUNTIME_SECRET_SEAL_KEY || undefined,
        streamStore: env.RUNTIME_STREAM_STORE === 'file' ? 'file' : 'postgres',
        // With the Postgres store, a set directory is read only for a Run that has no row in Postgres (written before the switch).
        streamDir: env.RUNTIME_STREAM_DIR || undefined,
        // Only the read-only URL (ADR-025): without it the cell reader answers 503 and the egress reader reads nothing.
        runtimeDatabaseReadUrl: env.RUNTIME_DATABASE_READ_URL || undefined,
        cellPrices: parseCellPrices(env.RUNTIME_CELL_PRICES),
    };
}

/**
 * RUNTIME_CELL_PRICES: JSON, cellId → { instanceType, usdPerHour?, region? },
 * for the Kodus-managed shared cells. Without usdPerHour the instance type's
 * list price (CELL_HOST_LIST_PRICES) is used; an entry with neither, or a
 * value that is not that JSON, prices nothing (the Run says "not priced"),
 * never stops the boot: it only feeds an estimate.
 */
export function parseCellPrices(raw: string | undefined): Record<string, CellHostPrice> {
    if (!raw?.trim()) return {};
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return {};
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, CellHostPrice> = {};
    for (const [cellId, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (!v || typeof v !== 'object') continue;
        const e = v as { instanceType?: unknown; usdPerHour?: unknown; region?: unknown };
        if (typeof e.instanceType !== 'string' || !e.instanceType) continue;
        const usdPerHour = typeof e.usdPerHour === 'number' && e.usdPerHour > 0 ? e.usdPerHour : CELL_HOST_LIST_PRICES[e.instanceType];
        if (!usdPerHour) continue;
        out[cellId] = { instanceType: e.instanceType, usdPerHour, region: typeof e.region === 'string' && e.region ? e.region : 'us-east-2' };
    }
    return out;
}
