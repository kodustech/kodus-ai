import { Inject, Injectable } from '@nestjs/common';

import { type IOutboxMessageRepository, OUTBOX_MESSAGE_REPOSITORY_TOKEN } from '@libs/core/workflow/domain/contracts/outbox-message.repository.contract';
import { createLogger } from '@libs/core/log/logger';

import { countPoolUsage, desiredPoolSize, effectivePoolSize, poolMonthlyEstimate, poolSpentUsd, type PoolDecision } from '../domain/pool';
import {
    RUNTIME_API_CONFIG,
    RUNTIME_CLOCK,
    RUNTIME_PRODUCT_ENVIRONMENT_STORE,
    type Clock,
    type ProductEnvironment,
    type ProductEnvironmentStore,
    type RuntimeApiConfig,
} from '../domain/ports';
import { RUNTIME_MACHINE_LIST_PRICES } from '../domain/run-cost';
import { RuntimeCommandName, runtimeCommandOutboxMessage } from '../domain/runtime-commands';

/** List price of one ready machine an hour: the VM a Run adopts (§11 sizing). */
export const POOL_USD_PER_MACHINE_HOUR = RUNTIME_MACHINE_LIST_PRICES.vm.usdPerHour;

/** The actor of a pool change no person asked for (the schedule, a pull request, the budget). */
const SCHEDULER = { userId: 'kodus-pool-scheduler' };

/** How many environments one scheduler tick looks at. */
const TICK_LIMIT = 500;

/** What the screen shows about the pool: the decision now, the month so far, the most it may cost. */
export interface PoolStatus extends PoolDecision {
    spentUsd: number;
    estimate: { hours: number | null; usd: number | null };
    usdPerMachineHour: number;
}

/**
 * Decides how many machines an environment's cell keeps ready (domain/pool.ts
 * desiredPoolSize) and asks for it through the outbox when it changes. The
 * settings, the pull request trigger and the scheduler all go through here,
 * so the size the cell holds always follows one rule. It also counts the
 * month's machine-minutes the budget is checked against.
 */
@Injectable()
export class RuntimePoolController {
    private readonly logger = createLogger(RuntimePoolController.name);

    constructor(
        @Inject(RUNTIME_PRODUCT_ENVIRONMENT_STORE)
        private readonly environments: ProductEnvironmentStore,
        @Inject(RUNTIME_API_CONFIG)
        private readonly config: Pick<RuntimeApiConfig, 'pool'>,
        @Inject(OUTBOX_MESSAGE_REPOSITORY_TOKEN)
        private readonly outbox: Pick<IOutboxMessageRepository, 'create'>,
        @Inject(RUNTIME_CLOCK)
        private readonly now: Clock,
    ) {}

    /** The pool of one environment as of now, without asking anything. */
    status(env: ProductEnvironment): PoolStatus {
        const now = this.now();
        const size = effectivePoolSize(this.config.pool, env.poolSize);
        const usage = countPoolUsage(env.poolUsage, env.poolAppliedSize ?? 0, now);
        const spentUsd = poolSpentUsd(usage, now, POOL_USD_PER_MACHINE_HOUR);
        return {
            ...desiredPoolSize({ size, policy: env.poolPolicy, now, lastPullRequestAt: env.poolActivityAt, spentUsd }),
            spentUsd,
            estimate: poolMonthlyEstimate(size, env.poolPolicy, POOL_USD_PER_MACHINE_HOUR),
            usdPerMachineHour: POOL_USD_PER_MACHINE_HOUR,
        };
    }

    /**
     * Brings the cell to the size the policy wants now. `force` asks even when
     * the size did not change (an admin saved the settings, a setup baked
     * again); otherwise only a change goes out.
     */
    async apply(env: ProductEnvironment, opts: { force?: boolean; requestedBy?: { userId: string; email?: string } } = {}): Promise<PoolDecision> {
        const now = this.now();
        const usage = countPoolUsage(env.poolUsage, env.poolAppliedSize ?? 0, now);
        const decision = this.status({ ...env, poolUsage: usage });
        const changed = decision.size !== (env.poolAppliedSize ?? null);
        if (changed || opts.force) {
            const requestedAt = now.toISOString();
            const key = `${env.environmentId}:pool:${requestedAt}`;
            await this.outbox.create(
                runtimeCommandOutboxMessage(
                    RuntimeCommandName.EnvironmentPoolRequested,
                    {
                        environmentId: env.environmentId,
                        organizationId: env.organizationId,
                        size: decision.size,
                        requestedBy: opts.requestedBy ?? SCHEDULER,
                        requestedAt,
                        key,
                    },
                    key,
                ),
            );
            this.logger.log({
                message: 'Runtime pool: size asked',
                context: RuntimePoolController.name,
                metadata: {
                    organizationId: env.organizationId,
                    environmentId: env.environmentId,
                    size: decision.size,
                    reason: decision.reason,
                    previous: env.poolAppliedSize ?? null,
                },
            });
        }
        await this.environments.setPoolApplied(env.organizationId, env.environmentId, decision.size, usage);
        return decision;
    }

    /** A pull request came in: the warm-up clock restarts, and a cold pool warms if the policy says so. */
    async onPullRequest(env: ProductEnvironment): Promise<void> {
        const at = this.now();
        await this.environments.markPoolActivity(env.organizationId, env.environmentId, at);
        if (!env.poolPolicy?.onPullRequest) return;
        await this.apply({ ...env, poolActivityAt: at.toISOString() });
    }

    /**
     * One scheduler pass over every environment with a policy or ready
     * machines: schedules open and close, warm-ups end, budgets run out. One
     * environment failing never stops the others.
     */
    async tick(): Promise<{ checked: number; failed: number }> {
        const envs = await this.environments.listPoolManagedAcrossOrganizations(TICK_LIMIT);
        let failed = 0;
        for (const env of envs) {
            try {
                await this.apply(env);
            } catch (error) {
                failed++;
                this.logger.error({
                    message: 'Runtime pool: tick failed for an environment',
                    context: RuntimePoolController.name,
                    error: error instanceof Error ? error : undefined,
                    metadata: { organizationId: env.organizationId, environmentId: env.environmentId },
                });
            }
        }
        return { checked: envs.length, failed };
    }
}
