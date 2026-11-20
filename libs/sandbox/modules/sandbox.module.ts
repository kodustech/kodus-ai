import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';

import { SANDBOX_PROVIDER_TOKEN } from '@libs/sandbox/domain/contracts/sandbox.provider';
import { SANDBOX_LEASE_MANAGER_TOKEN } from '@libs/sandbox/domain/contracts/sandbox-lease-manager.contract';
import { E2BSandboxService } from '@libs/sandbox/infrastructure/providers/e2b-sandbox.service';
import { LocalSandboxService } from '@libs/sandbox/infrastructure/providers/local-sandbox.service';
import { NullSandboxProvider } from '@libs/sandbox/infrastructure/providers/null-sandbox.service';
import { RuntimeSandboxService } from '@libs/sandbox/infrastructure/providers/runtime-sandbox.service';
import {
    SandboxLeaseModel,
    SandboxLeaseSchema,
} from '@libs/sandbox/infrastructure/repositories/schemas/sandbox-lease.model';
import { SandboxLeaseRepository } from '@libs/sandbox/infrastructure/repositories/sandbox-lease.repository';
import { SandboxLeaseManager } from '@libs/sandbox/infrastructure/services/sandbox-lease-manager.service';
import { SandboxLeaseReaperService } from '@libs/sandbox/infrastructure/services/sandbox-lease-reaper.service';
import {
    SANDBOX_CONCURRENCY_CONFIG_SERVICE_TOKEN,
    SandboxConcurrencyConfigService,
} from '@libs/sandbox/infrastructure/services/sandbox-concurrency-config.service';
import {
    ISandboxEgressPolicy,
    SANDBOX_EGRESS_POLICY_TOKEN,
    SandboxEgressPolicyService,
} from '@libs/sandbox/infrastructure/services/sandbox-egress-policy.service';
import {
    AdvisoryLockCapacityStore,
    SANDBOX_CAPACITY_GATE_TOKEN,
    SandboxCapacityGate,
    readSandboxCapacityEnv,
} from '@libs/sandbox/infrastructure/services/sandbox-capacity-gate';
import { DistributedLockService } from '@libs/core/workflow/infrastructure/distributed-lock.service';
import { GlobalParametersModule } from '@libs/organization/modules/global-parameters.module';
import { IntegrationConfigModule } from '@libs/integrations/modules/config.module';

/**
 * SANDBOX_PROVIDER picks the sandbox (docs/runtime/sandbox.md):
 *   - null, local, e2b, runtime: that provider, as asked;
 *   - auto (the default): e2b when API_E2B_KEY is set (Kodus Cloud today),
 *     else local (commands in the worker's own container, no isolation).
 * auto never picks runtime, even with the Runtime configured: the provider is
 * one per deployment, and the Kody Runtime is released per org (alpha). Auto
 * picking it would move every org's code review onto the Runtime's cells, so a
 * cell outage would break the review of orgs that never had the Runtime.
 * SANDBOX_PROVIDER=runtime opts the whole deployment in.
 */
export function selectSandboxProvider(
    configService: ConfigService,
    egressPolicy?: ISandboxEgressPolicy,
) {
    const provider = configService.get<string>('SANDBOX_PROVIDER') || 'auto';
    if (provider === 'null') return new NullSandboxProvider();
    if (provider === 'local') return new LocalSandboxService(configService);
    if (provider === 'e2b') return new E2BSandboxService(configService, egressPolicy);
    if (provider === 'runtime' || provider === 'runtime-sandbox') return new RuntimeSandboxService(configService);
    if (configService.get<string>('API_E2B_KEY')) return new E2BSandboxService(configService, egressPolicy);
    return new LocalSandboxService(configService);
}

@Module({
    imports: [
        MongooseModule.forFeature([
            { name: SandboxLeaseModel.name, schema: SandboxLeaseSchema },
        ]),
        GlobalParametersModule,
        IntegrationConfigModule,
    ],
    providers: [
        {
            provide: SANDBOX_PROVIDER_TOKEN,
            useFactory: (
                configService: ConfigService,
                egressPolicy: ISandboxEgressPolicy,
            ) => selectSandboxProvider(configService, egressPolicy),
            inject: [ConfigService, SANDBOX_EGRESS_POLICY_TOKEN],
        },
        {
            provide: SANDBOX_EGRESS_POLICY_TOKEN,
            useClass: SandboxEgressPolicyService,
        },
        SandboxLeaseRepository,
        // Deployment-wide cap (SANDBOX_MAX_CONCURRENT): a no-op while unset.
        // The lock service only needs the TypeORM DataSource.
        DistributedLockService,
        {
            provide: SANDBOX_CAPACITY_GATE_TOKEN,
            useFactory: (locks: DistributedLockService) =>
                new SandboxCapacityGate(
                    readSandboxCapacityEnv().maxConcurrent > 0
                        ? new AdvisoryLockCapacityStore(locks)
                        : undefined,
                ),
            inject: [DistributedLockService],
        },
        {
            provide: SANDBOX_CONCURRENCY_CONFIG_SERVICE_TOKEN,
            useClass: SandboxConcurrencyConfigService,
        },
        {
            provide: SANDBOX_LEASE_MANAGER_TOKEN,
            useClass: SandboxLeaseManager,
        },
        SandboxLeaseReaperService,
    ],
    exports: [SANDBOX_PROVIDER_TOKEN, SANDBOX_LEASE_MANAGER_TOKEN],
})
export class SandboxModule {}
