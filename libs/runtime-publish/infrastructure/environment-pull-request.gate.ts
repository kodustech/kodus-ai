import type { Repository } from 'typeorm';

import type { RuntimeEnvironmentModel } from '@libs/runtime/api/infrastructure/runtime-product.models';

import type { RuntimePullRequestGate } from '../domain/pull-request-observation-gate';

/** How long an answer is reused: a new environment sees its PR events after at most this. */
export const GATE_CACHE_TTL_MS = 30_000;
const MAX_ENTRIES = 10_000;

/** A repository is recorded when it has a Runtime environment (product Postgres, `runtime_environments`). */
export class EnvironmentPullRequestGate implements RuntimePullRequestGate {
    private readonly cache = new Map<string, { value: boolean; until: number }>();

    constructor(
        private readonly environments: Pick<Repository<RuntimeEnvironmentModel>, 'exists'>,
        private readonly now: () => number = Date.now,
    ) {}

    async shouldRecord(input: { organizationId: string; repositoryId: string }): Promise<boolean> {
        const key = `${input.organizationId}/${input.repositoryId}`;
        const hit = this.cache.get(key);
        if (hit && hit.until > this.now()) return hit.value;
        const value = await this.environments.exists({
            where: { organizationId: input.organizationId, repositoryId: input.repositoryId },
        });
        if (this.cache.size >= MAX_ENTRIES) this.cache.clear();
        this.cache.set(key, { value, until: this.now() + GATE_CACHE_TTL_MS });
        return value;
    }
}
