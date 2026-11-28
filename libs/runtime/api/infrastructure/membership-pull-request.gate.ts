import type { Repository } from 'typeorm';

import type { RuntimePullRequestGate } from '@libs/runtime-publish/domain/pull-request-observation-gate';

import type { RuntimeEnvironmentModel, RuntimeEnvironmentRepositoryModel } from './runtime-product.models';

/** How long an answer is reused: a repository added to an environment sees its PR events after at most this. */
export const MEMBERSHIP_GATE_CACHE_TTL_MS = 30_000;
const MAX_ENTRIES = 10_000;

/**
 * The webhook gate through membership: a repository's pull request events
 * are recorded when it is part of a Runtime environment, as its primary or a
 * member (`runtime_environment_repositories`). The environment's own row
 * still counts, so an environment from before the membership table (or
 * between its create and its primary row) keeps its events.
 */
export class MembershipPullRequestGate implements RuntimePullRequestGate {
    private readonly cache = new Map<string, { value: boolean; until: number }>();

    constructor(
        private readonly memberships: Pick<Repository<RuntimeEnvironmentRepositoryModel>, 'exists'>,
        private readonly environments: Pick<Repository<RuntimeEnvironmentModel>, 'exists'>,
        private readonly now: () => number = Date.now,
    ) {}

    async shouldRecord(input: { organizationId: string; repositoryId: string }): Promise<boolean> {
        const key = `${input.organizationId}/${input.repositoryId}`;
        const hit = this.cache.get(key);
        if (hit && hit.until > this.now()) return hit.value;
        const where = { organizationId: input.organizationId, repositoryId: input.repositoryId };
        const value = (await this.memberships.exists({ where })) || (await this.environments.exists({ where }));
        if (this.cache.size >= MAX_ENTRIES) this.cache.clear();
        this.cache.set(key, { value, until: this.now() + MEMBERSHIP_GATE_CACHE_TTL_MS });
        return value;
    }
}
