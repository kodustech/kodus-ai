import { Inject, Injectable, Optional } from '@nestjs/common';

import { GlobalParametersKey } from '@libs/core/domain/enums/global-parameters-key.enum';
import { createLogger } from '@libs/core/log/logger';
import {
    GLOBAL_PARAMETERS_SERVICE_TOKEN,
    IGlobalParametersService,
} from '@libs/organization/domain/global-parameters/contracts/global-parameters.service.contract';

import {
    DEFAULT_SANDBOX_QUEUE_MAX_WAIT_MS,
    SandboxCapacityEnv,
    readSandboxCapacityEnv,
} from './sandbox-capacity-gate';

export const MAX_SANDBOX_CONCURRENT_LIMIT = 100;
export const MIN_SANDBOX_QUEUE_WAIT_MS = 60_000;
export const MAX_SANDBOX_QUEUE_WAIT_MS = 60 * 60_000;

/** A change saved on the screen reaches every worker within this window. */
export const CAPACITY_SETTINGS_CACHE_TTL_MS = 10_000;

const FAILED_READ_RETRY_MS = 5_000;

/** What is stored: a null/absent field defers to the env, `maxConcurrent: null` stored = no cap. */
export interface SandboxCapacityStored {
    maxConcurrent: number | null;
    maxWaitMs: number;
}

export interface SandboxCapacitySettingsInput {
    maxConcurrent: number | null;
    maxWaitMs: number;
}

export const SANDBOX_CAPACITY_SETTINGS_TOKEN = Symbol(
    'SANDBOX_CAPACITY_SETTINGS_TOKEN',
);

/** Returns an error message, or null when the input is valid. */
export function validateCapacityInput(input: {
    maxConcurrent: unknown;
    maxWaitMs: unknown;
}): string | null {
    const c = input.maxConcurrent;
    if (
        c !== null &&
        (typeof c !== 'number' ||
            !Number.isInteger(c) ||
            c < 1 ||
            c > MAX_SANDBOX_CONCURRENT_LIMIT)
    ) {
        return `maxConcurrent must be an integer from 1 to ${MAX_SANDBOX_CONCURRENT_LIMIT}, or null for no cap`;
    }
    const w = input.maxWaitMs;
    if (
        typeof w !== 'number' ||
        !Number.isInteger(w) ||
        w < MIN_SANDBOX_QUEUE_WAIT_MS ||
        w > MAX_SANDBOX_QUEUE_WAIT_MS
    ) {
        return `maxWaitMs must be an integer from ${MIN_SANDBOX_QUEUE_WAIT_MS} to ${MAX_SANDBOX_QUEUE_WAIT_MS}`;
    }
    return null;
}

/**
 * The deployment-wide sandbox cap and queue wait, persisted in the
 * `sandbox_capacity` global parameter so they change without a deploy:
 *
 *   configValue = { "maxConcurrent": 5 | null, "maxWaitMs": 600000 }
 *
 * Precedence per field: database value, then env (SANDBOX_MAX_CONCURRENT,
 * SANDBOX_QUEUE_MAX_WAIT_MS), then the default. A stored value that fails
 * validation keeps the last good settings and warns; a failed read does too.
 */
@Injectable()
export class SandboxCapacitySettingsService {
    private readonly logger = createLogger(SandboxCapacitySettingsService.name);
    private effective: SandboxCapacityEnv;
    private stored: SandboxCapacityStored | null = null;
    private cachedAt = 0;
    private retryReadAt = 0;

    constructor(
        @Optional()
        @Inject(GLOBAL_PARAMETERS_SERVICE_TOKEN)
        private readonly globalParameters?: IGlobalParametersService,
    ) {
        this.effective = this.readEnv();
    }

    /** Overridable in specs. */
    readEnv: () => SandboxCapacityEnv = readSandboxCapacityEnv;
    now: () => number = Date.now;

    /** The settings in force, as of the last refresh (sync, for the gate). */
    current(): SandboxCapacityEnv {
        return this.effective;
    }

    /** The stored value, as of the last refresh; null when nothing is stored. */
    storedSettings(): SandboxCapacityStored | null {
        return this.stored;
    }

    /** The env defaults, for the screen's "default" hint. */
    envDefaults(): SandboxCapacityEnv {
        return this.readEnv();
    }

    async refresh(force = false): Promise<void> {
        if (!this.globalParameters) return;
        const now = this.now();
        if (!force) {
            if (this.cachedAt && now - this.cachedAt < CAPACITY_SETTINGS_CACHE_TTL_MS) return;
            if (now < this.retryReadAt) return;
        }
        try {
            const param = await this.globalParameters.findByKey(
                GlobalParametersKey.SANDBOX_CAPACITY,
            );
            this.apply(param?.configValue);
            this.cachedAt = now;
        } catch (error) {
            this.retryReadAt = now + FAILED_READ_RETRY_MS;
            this.logger.warn({
                message:
                    'Could not read sandbox_capacity global parameter; keeping the last known settings',
                context: SandboxCapacitySettingsService.name,
                error,
                metadata: { settings: this.effective },
            });
        }
    }

    /** Validates, persists and applies at once on this process. */
    async update(input: SandboxCapacitySettingsInput): Promise<void> {
        const invalid = validateCapacityInput(input);
        if (invalid) throw new Error(invalid);
        if (!this.globalParameters) {
            throw new Error('Global parameters are not available');
        }
        await this.globalParameters.createOrUpdateConfig(
            GlobalParametersKey.SANDBOX_CAPACITY,
            { maxConcurrent: input.maxConcurrent, maxWaitMs: input.maxWaitMs },
        );
        await this.refresh(true);
    }

    private apply(value: unknown): void {
        const env = this.readEnv();
        if (value === undefined || value === null) {
            this.stored = null;
            this.effective = env;
            return;
        }
        const raw = (typeof value === 'object' ? value : {}) as Record<string, unknown>;
        // An absent field defers to the env; a stored `null` is "no cap"
        const maxConcurrent = 'maxConcurrent' in raw ? raw.maxConcurrent : env.maxConcurrent || null;
        const maxWaitMs = raw.maxWaitMs !== undefined ? raw.maxWaitMs : env.maxWaitMs;
        const invalid =
            typeof value !== 'object'
                ? 'not an object'
                : validateCapacityInput({ maxConcurrent, maxWaitMs });
        if (invalid) {
            this.logger.warn({
                message:
                    'sandbox_capacity global parameter is invalid; keeping the last good settings',
                context: SandboxCapacitySettingsService.name,
                metadata: { configValue: value, reason: invalid },
            });
            return;
        }
        this.stored = {
            maxConcurrent: maxConcurrent as number | null,
            maxWaitMs: maxWaitMs as number,
        };
        this.effective = {
            maxConcurrent: (maxConcurrent as number | null) ?? 0,
            maxWaitMs: maxWaitMs as number,
        };
    }
}
