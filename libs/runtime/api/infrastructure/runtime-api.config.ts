import { PreviewDomainSchema } from '@libs/runtime/contracts/preview';
import { loadS3EvidenceConfig } from '@libs/runtime/contracts/evidence-s3';
import { envIntOr } from '@libs/runtime/contracts/env-int';
import { DEFAULT_EXERCISED_LINES_THRESHOLD_PERCENT, DEFAULT_MAX_TOKENS_PER_RUN } from '@libs/runtime/contracts/limits';
import { isMachineSizePreset } from '@libs/runtime/contracts/machine-size';
import { assertProductionSecret } from '@libs/runtime/contracts/production-secrets';
import { DEFAULT_MACHINE_MINUTES_PER_ORG_DAY } from '@libs/runtime/environment/machine-minutes';

import { parseDenylist } from '../domain/egress';
import { CELL_HOST_LIST_PRICES, type CellHostPrice } from '../domain/run-cost';
import type { RuntimeApiConfig } from '../domain/ports';
import { type WebhookReconcilerConfig } from '../domain/webhook-reconciler';

const MINUTE = 60_000;

/** The reconciler's settings, conservative by default; the interval is the cron's (RUNTIME_CRON_WEBHOOK_RECONCILER). */
export function loadWebhookReconcilerConfig(env: NodeJS.ProcessEnv = process.env): WebhookReconcilerConfig {
    const positiveInt = (value: string | undefined, fallback: number, max: number) => Math.min(envIntOr(value, fallback, 1), max);
    return {
        enabled: env.RUNTIME_WEBHOOK_RECONCILER_ENABLED === 'true',
        windowMs: positiveInt(env.RUNTIME_WEBHOOK_RECONCILER_WINDOW_MINUTES, 24 * 60, 7 * 24 * 60) * MINUTE,
        graceMs: positiveInt(env.RUNTIME_WEBHOOK_RECONCILER_GRACE_MINUTES, 10, 24 * 60) * MINUTE,
        perOrgPerTick: positiveInt(env.RUNTIME_WEBHOOK_RECONCILER_PER_ORG_PER_TICK, 2, 50),
        perTick: positiveInt(env.RUNTIME_WEBHOOK_RECONCILER_PER_TICK, 10, 200),
        repositoriesPerTick: positiveInt(env.RUNTIME_WEBHOOK_RECONCILER_REPOSITORIES_PER_TICK, 100, 2_000),
    };
}

/** Kodus's own address (API_FRONTEND_URL), for links in what the API posts on a PR; undefined when unset. */
export function loadDashboardUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
    return env.API_FRONTEND_URL?.trim() || undefined;
}

const atLeastZero = (value: string | undefined, fallback: number) => envIntOr(value, fallback, 0);

/** A whole percent from 0 to 100; anything else takes the default (the worker refuses it at boot). */
const percentOr = (value: string | undefined, fallback: number) => {
    const n = envIntOr(value, fallback, 0);
    return n <= 100 ? n : fallback;
};

/** A US$ price: a finite number at least 0; anything else is 0 ("not set"). */
const usdPrice = (value: string | undefined) => {
    const n = Number(value);
    return value !== undefined && value.trim() !== '' && Number.isFinite(n) && n >= 0 ? n : 0;
};

const int = (value: string | undefined, fallback: number) => envIntOr(value, fallback, 1);

/** Runtime settings of the API, from the environment (RUNTIME_* names, shared with apps/runtime where they overlap). */
export function loadRuntimeApiConfig(env: NodeJS.ProcessEnv = process.env): RuntimeApiConfig {
    // The production image (NODE_ENV=production, as apps/runtime reads it) never signs with the dev composes' secrets.
    const production = env.NODE_ENV === 'production' || env.RUNTIME_PRODUCTION_IMAGE === '1';
    assertProductionSecret('RUNTIME_RUN_TOKEN_SECRET', env.RUNTIME_RUN_TOKEN_SECRET, production);
    assertProductionSecret('RUNTIME_EVIDENCE_SIGNING_SECRET', env.RUNTIME_EVIDENCE_SIGNING_SECRET, production);
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
            perRun: int(env.RUNTIME_LLM_MAX_TOKENS_PER_RUN ?? env.RUNTIME_MAX_TOKENS_PER_RUN, DEFAULT_MAX_TOKENS_PER_RUN),
            perPullRequest: int(env.RUNTIME_LLM_MAX_TOKENS_PER_PR, 600_000),
            perOrgPerDay: int(env.RUNTIME_LLM_MAX_TOKENS_PER_ORG_DAY, 5_000_000),
            // The recipe author reads up to RECIPE_AUTHOR_LIMITS.maxTokens (400k) per run; a setup may run it
            // three times (the first recipe and RUNTIME_SETUP_AUTHOR_REPAIRS rewrites after a failed build).
            perSetup: int(env.RUNTIME_LLM_MAX_TOKENS_PER_SETUP, 1_200_000),
        },
        // Off unless the deployment's plan sets a default; an admin may go up to the ceiling.
        pool: (() => {
            const maxSize = atLeastZero(env.RUNTIME_POOL_MAX_SIZE, 4);
            return { defaultSize: Math.min(atLeastZero(env.RUNTIME_POOL_DEFAULT_SIZE, 0), maxSize), maxSize };
        })(),
        // Every preset unless the deployment's plan lowers it, as the pool's ceiling (4) is open by default.
        machineSize: { maxPreset: isMachineSizePreset(env.RUNTIME_MACHINE_SIZE_MAX) ? env.RUNTIME_MACHINE_SIZE_MAX : 'large' },
        suiteCi: env.RUNTIME_SUITE_CI === 'true',
        oncallUserIds: (env.RUNTIME_ONCALL_USER_IDS ?? '')
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
        egressDenylist: parseDenylist(env.RUNTIME_EGRESS_DENYLIST),
        streamLongPollMs: int(env.RUNTIME_STREAM_LONG_POLL_MS, 20_000),
        streamPollIntervalMs: int(env.RUNTIME_STREAM_POLL_INTERVAL_MS, 500),
        secretSealKey: env.RUNTIME_SECRET_SEAL_KEY || undefined,
        previewGrantPrivateKey: env.RUNTIME_PREVIEW_GRANT_PRIVATE_KEY || undefined,
        // The same variable the worker reads (decision 1): unset, the product offers no preview anywhere.
        ...(PreviewDomainSchema.safeParse(env.RUNTIME_PREVIEW_DOMAIN?.trim().toLowerCase()).success ? { previewDomain: env.RUNTIME_PREVIEW_DOMAIN!.trim().toLowerCase() } : {}),
        // Dev only: the port a local preview edge listens on (3430); a deployment serves 443 and leaves it unset.
        ...(env.RUNTIME_PREVIEW_PUBLIC_PORT && /^[0-9]{2,5}$/.test(env.RUNTIME_PREVIEW_PUBLIC_PORT) ? { previewPublicPort: Number(env.RUNTIME_PREVIEW_PUBLIC_PORT) } : {}),
        streamStore: env.RUNTIME_STREAM_STORE === 'file' ? 'file' : 'postgres',
        // With the Postgres store, a set directory is read only for a Run that has no row in Postgres (written before the switch).
        streamDir: env.RUNTIME_STREAM_DIR || undefined,
        // Only the read-only URL (ADR-025): without it the cell reader answers 503 and the egress reader reads nothing.
        runtimeDatabaseReadUrl: env.RUNTIME_DATABASE_READ_URL || undefined,
        cellPrices: parseCellPrices(env.RUNTIME_CELL_PRICES),
        // The usage report's unit prices for machine time; 0 (the default) prices nothing. Never a built-in price.
        machineUnitPrices: {
            usdPerGbMinute: usdPrice(env.RUNTIME_MACHINE_USD_PER_GB_MINUTE),
            usdPerVcpuMinute: usdPrice(env.RUNTIME_MACHINE_USD_PER_VCPU_MINUTE),
        },
        // The same name and default as the hub's (apps/runtime/src/shared/config.ts): only shown here, enforced there.
        machineMinutesPerOrgDay: atLeastZero(env.RUNTIME_MACHINE_MINUTES_PER_ORG_DAY, DEFAULT_MACHINE_MINUTES_PER_ORG_DAY),
        // The worker's name and default (apps/runtime/src/shared/config.ts): only shown here as the org's default, applied there.
        exercisedLinesThresholdPercent: percentOr(env.RUNTIME_EXERCISED_LINES_THRESHOLD_PERCENT, DEFAULT_EXERCISED_LINES_THRESHOLD_PERCENT),
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
