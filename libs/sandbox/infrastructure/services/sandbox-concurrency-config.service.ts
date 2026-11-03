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

/** Changes to the global parameter reach every worker within this window. */
const CACHE_TTL_MS = 60_000;

/**
 * Reads the per-worker sandbox cap from the `sandbox_concurrency` global
 * parameter, so it can be tuned in the database without a deploy:
 *
 *   configValue = { "maxPerWorker": 6 }
 *
 * A review that finds every slot taken waits in line for one; it never
 * runs without its sandbox.
 *
 * Any read failure keeps the last known limits (or the defaults): a database
 * hiccup must not block or un-cap sandbox creation.
 */
@Injectable()
export class SandboxConcurrencyConfigService {
    private readonly logger = createLogger(
        SandboxConcurrencyConfigService.name,
    );
    private cached: SandboxConcurrencyLimits =
        DEFAULT_SANDBOX_CONCURRENCY_LIMITS;
    private cachedAt = 0;

    constructor(
        @Optional()
        @Inject(GLOBAL_PARAMETERS_SERVICE_TOKEN)
        private readonly globalParameters?: IGlobalParametersService,
    ) {}

    async getLimits(): Promise<SandboxConcurrencyLimits> {
        if (!this.globalParameters) return this.cached;
        if (this.cachedAt && Date.now() - this.cachedAt < CACHE_TTL_MS) {
            return this.cached;
        }

        try {
            const param = await this.globalParameters.findByKey(
                GlobalParametersKey.SANDBOX_CONCURRENCY,
            );
            this.cached = parseLimits(param?.configValue);
        } catch (error) {
            this.logger.warn({
                message:
                    'Could not read sandbox_concurrency global parameter; keeping last known limits',
                context: SandboxConcurrencyConfigService.name,
                error,
                metadata: { limits: this.cached },
            });
        }
        this.cachedAt = Date.now();
        return this.cached;
    }
}

export function parseLimits(value: unknown): SandboxConcurrencyLimits {
    if (!value || typeof value !== 'object') {
        return DEFAULT_SANDBOX_CONCURRENCY_LIMITS;
    }
    const raw = value as Record<string, unknown>;
    return {
        maxPerWorker: nonNegativeInt(
            raw.maxPerWorker,
            DEFAULT_SANDBOX_CONCURRENCY_LIMITS.maxPerWorker,
        ),
    };
}

function nonNegativeInt(value: unknown, fallback: number): number {
    const n = typeof value === 'string' ? Number(value) : value;
    return typeof n === 'number' && Number.isFinite(n) && n >= 0
        ? Math.floor(n)
        : fallback;
}
