import { Inject, Injectable, Optional } from '@nestjs/common';

import { GlobalParametersKey } from '@libs/core/domain/enums/global-parameters-key.enum';
import { createLogger } from '@libs/core/log/logger';
import {
    GLOBAL_PARAMETERS_SERVICE_TOKEN,
    IGlobalParametersService,
} from '@libs/organization/domain/global-parameters/contracts/global-parameters.service.contract';

import { SandboxConcurrencyLimits } from './sandbox-concurrency-limiter';

/**
 * Default when the `sandbox_concurrency` global parameter is absent:
 * no cap (self-hosted and local sandboxes have no E2B plan limit).
 */
export const DEFAULT_SANDBOX_CONCURRENCY_LIMITS: SandboxConcurrencyLimits = {
    maxPerWorker: 0,
};

/**
 * Above any sane per-worker share of an E2B plan: a larger value is a typo
 * (an extra zero), not a cap, and falls back to the default with a warn.
 */
export const MAX_SANDBOX_PER_WORKER = 100;

/** Changes to the global parameter reach every worker within this window. */
const CACHE_TTL_MS = 60_000;

/** A failed read is retried this soon, not after a whole TTL. */
const FAILED_READ_RETRY_MS = 5_000;

export interface ISandboxConcurrencyConfigService {
    getLimits(): Promise<SandboxConcurrencyLimits>;
}

export const SANDBOX_CONCURRENCY_CONFIG_SERVICE_TOKEN = Symbol(
    'SANDBOX_CONCURRENCY_CONFIG_SERVICE_TOKEN',
);

const logger = createLogger('SandboxConcurrencyConfig');

/**
 * Reads the per-worker sandbox cap from the `sandbox_concurrency` global
 * parameter, so it can be tuned in the database without a deploy:
 *
 *   configValue = { "maxPerWorker": 6 }
 *
 * A review that finds every slot taken waits in line for one; it never
 * runs without its sandbox.
 *
 * A failed read keeps the last known limits and is retried within
 * FAILED_READ_RETRY_MS; before the first successful read that is the default
 * (no cap), said so in the warn: a database hiccup must not block sandbox
 * creation.
 */
@Injectable()
export class SandboxConcurrencyConfigService implements ISandboxConcurrencyConfigService {
    private readonly logger = createLogger(
        SandboxConcurrencyConfigService.name,
    );
    private cached: SandboxConcurrencyLimits =
        DEFAULT_SANDBOX_CONCURRENCY_LIMITS;
    private cachedAt = 0;
    private retryReadAt = 0;

    constructor(
        @Optional()
        @Inject(GLOBAL_PARAMETERS_SERVICE_TOKEN)
        private readonly globalParameters?: IGlobalParametersService,
    ) {}

    async getLimits(): Promise<SandboxConcurrencyLimits> {
        if (!this.globalParameters) return this.cached;
        const now = Date.now();
        if (this.cachedAt && now - this.cachedAt < CACHE_TTL_MS) {
            return this.cached;
        }
        if (now < this.retryReadAt) return this.cached;

        try {
            const param = await this.globalParameters.findByKey(
                GlobalParametersKey.SANDBOX_CONCURRENCY,
            );
            this.cached = parseLimits(param?.configValue);
            this.cachedAt = now;
        } catch (error) {
            this.retryReadAt = now + FAILED_READ_RETRY_MS;
            this.logger.warn({
                message: this.cachedAt
                    ? 'Could not read sandbox_concurrency global parameter; keeping last known limits'
                    : 'Could not read sandbox_concurrency global parameter yet; no per-worker cap until it can be read',
                context: SandboxConcurrencyConfigService.name,
                error,
                metadata: {
                    limits: this.cached,
                    neverRead: !this.cachedAt,
                    retryInMs: FAILED_READ_RETRY_MS,
                },
            });
        }
        return this.cached;
    }
}

export function parseLimits(value: unknown): SandboxConcurrencyLimits {
    if (!value || typeof value !== 'object') {
        return DEFAULT_SANDBOX_CONCURRENCY_LIMITS;
    }
    const raw = value as Record<string, unknown>;
    const fallback = DEFAULT_SANDBOX_CONCURRENCY_LIMITS.maxPerWorker;
    const maxPerWorker = nonNegativeInt(raw.maxPerWorker, fallback);
    if (maxPerWorker > MAX_SANDBOX_PER_WORKER) {
        logger.warn({
            message:
                'sandbox_concurrency.maxPerWorker is above the ceiling; using the default',
            context: 'SandboxConcurrencyConfig',
            metadata: {
                configured: raw.maxPerWorker,
                max: MAX_SANDBOX_PER_WORKER,
                default: fallback,
            },
        });
        return { maxPerWorker: fallback };
    }
    return { maxPerWorker };
}

function nonNegativeInt(value: unknown, fallback: number): number {
    const n = typeof value === 'string' ? Number(value) : value;
    return typeof n === 'number' && Number.isFinite(n) && n >= 0
        ? Math.floor(n)
        : fallback;
}
