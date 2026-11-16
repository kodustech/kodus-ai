import { Global, Module } from '@nestjs/common';
import { getRepositoryToken, TypeOrmModule } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';

import { MembershipPullRequestGate } from '@libs/runtime/api/infrastructure/membership-pull-request.gate';
import { RuntimeEnvironmentModel, RuntimeEnvironmentRepositoryModel } from '@libs/runtime/api/infrastructure/runtime-product.models';

import { RUNTIME_PULL_REQUEST_GATE_TOKEN } from './domain/pull-request-observation-gate';

/** The gate the webhook handlers take: membership first, the environment's own row too. */
export const pullRequestGateOf = (memberships: Pick<Repository<RuntimeEnvironmentRepositoryModel>, 'exists'>, environments: Pick<Repository<RuntimeEnvironmentModel>, 'exists'>) =>
    new MembershipPullRequestGate(memberships, environments);

/**
 * Global so the platform webhook handlers can take the gate as an optional
 * dependency: imported only where Kody Runtime is on (isKodyRuntimeEnabled),
 * and without it the handlers record no pull request event for the Runtime.
 */
@Global()
@Module({
    imports: [TypeOrmModule.forFeature([RuntimeEnvironmentModel, RuntimeEnvironmentRepositoryModel])],
    providers: [
        {
            provide: RUNTIME_PULL_REQUEST_GATE_TOKEN,
            // A repository's PR events are recorded when it is in an environment, as its primary or a member.
            useFactory: pullRequestGateOf,
            inject: [getRepositoryToken(RuntimeEnvironmentRepositoryModel), getRepositoryToken(RuntimeEnvironmentModel)],
        },
    ],
    exports: [RUNTIME_PULL_REQUEST_GATE_TOKEN],
})
export class RuntimePullRequestGateModule {}
