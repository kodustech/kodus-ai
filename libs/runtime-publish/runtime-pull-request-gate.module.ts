import { Global, Module } from '@nestjs/common';
import { getRepositoryToken, TypeOrmModule } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';

import { RuntimeEnvironmentModel } from '@libs/runtime/api/infrastructure/runtime-product.models';

import { RUNTIME_PULL_REQUEST_GATE_TOKEN } from './domain/pull-request-observation-gate';
import { EnvironmentPullRequestGate } from './infrastructure/environment-pull-request.gate';

/**
 * Global so the platform webhook handlers can take the gate as an optional
 * dependency: imported only where Kody Runtime is on (isKodyRuntimeEnabled),
 * and without it the handlers record no pull request event for the Runtime.
 */
@Global()
@Module({
    imports: [TypeOrmModule.forFeature([RuntimeEnvironmentModel])],
    providers: [
        {
            provide: RUNTIME_PULL_REQUEST_GATE_TOKEN,
            useFactory: (repo: Repository<RuntimeEnvironmentModel>) =>
                new EnvironmentPullRequestGate(repo),
            inject: [getRepositoryToken(RuntimeEnvironmentModel)],
        },
    ],
    exports: [RUNTIME_PULL_REQUEST_GATE_TOKEN],
})
export class RuntimePullRequestGateModule {}
