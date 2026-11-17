import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';

import {
    IPostHogProvider,
    POSTHOG_PROVIDER_TOKEN,
} from '@libs/telemetry/infrastructure/providers/posthog.provider';
import { TelemetryModule } from '@libs/telemetry/modules/telemetry.module';

import { SANDBOX_PROVIDER_TOKEN } from '@libs/sandbox/domain/contracts/sandbox.provider';
import { SANDBOX_LEASE_MANAGER_TOKEN } from '@libs/sandbox/domain/contracts/sandbox-lease-manager.contract';
import { createE2BProbeSandbox } from '@libs/sandbox/infrastructure/providers/e2b-probe-sandbox';
import { E2BSandboxService } from '@libs/sandbox/infrastructure/providers/e2b-sandbox.service';
import { LocalSandboxService } from '@libs/sandbox/infrastructure/providers/local-sandbox.service';
import { NullSandboxProvider } from '@libs/sandbox/infrastructure/providers/null-sandbox.service';
import {
    SandboxLeaseModel,
    SandboxLeaseSchema,
} from '@libs/sandbox/infrastructure/repositories/schemas/sandbox-lease.model';
import { SandboxLeaseRepository } from '@libs/sandbox/infrastructure/repositories/sandbox-lease.repository';
import {
    SandboxEgressProbeModel,
    SandboxEgressProbeSchema,
} from '@libs/sandbox/infrastructure/repositories/schemas/sandbox-egress-probe.model';
import { SandboxEgressProbeRepository } from '@libs/sandbox/infrastructure/repositories/sandbox-egress-probe.repository';
import {
    SANDBOX_EGRESS_PROBE_FLAG,
    SandboxEgressProbeService,
} from '@libs/sandbox/infrastructure/services/egress-probe/sandbox-egress-probe.service';
import { SandboxLeaseManager } from '@libs/sandbox/infrastructure/services/sandbox-lease-manager.service';
import { SandboxLeaseReaperService } from '@libs/sandbox/infrastructure/services/sandbox-lease-reaper.service';
import {
    SANDBOX_CONCURRENCY_CONFIG_SERVICE_TOKEN,
    SandboxConcurrencyConfigService,
} from '@libs/sandbox/infrastructure/services/sandbox-concurrency-config.service';
import { GlobalParametersModule } from '@libs/organization/modules/global-parameters.module';

@Module({
    imports: [
        MongooseModule.forFeature([
            { name: SandboxLeaseModel.name, schema: SandboxLeaseSchema },
            {
                name: SandboxEgressProbeModel.name,
                schema: SandboxEgressProbeSchema,
            },
        ]),
        GlobalParametersModule,
        // Explicit, like FeatureGateModule: the probe's rollout flag reads
        // POSTHOG_PROVIDER_TOKEN, and relying on @Global alone races at boot.
        TelemetryModule,
    ],
    providers: [
        SandboxEgressProbeRepository,
        {
            provide: SandboxEgressProbeService,
            useFactory: (
                configService: ConfigService,
                store: SandboxEgressProbeRepository,
                posthog: IPostHogProvider,
            ) =>
                new SandboxEgressProbeService({
                    store,
                    createSandbox: () =>
                        createE2BProbeSandbox(
                            configService.get<string>('API_E2B_KEY') ?? '',
                            configService.get<string>('API_NODE_ENV'),
                        ),
                    // Off until the PostHog flag targets the org.
                    isEnabled: (request) =>
                        posthog.isFeatureEnabled(
                            SANDBOX_EGRESS_PROBE_FLAG,
                            request.organizationId,
                            {
                                organizationId: request.organizationId,
                                teamId: request.teamId,
                            },
                        ),
                }),
            inject: [
                ConfigService,
                SandboxEgressProbeRepository,
                POSTHOG_PROVIDER_TOKEN,
            ],
        },
        {
            provide: SANDBOX_PROVIDER_TOKEN,
            useFactory: (
                configService: ConfigService,
                egressProbe: SandboxEgressProbeService,
            ) => {
                const provider =
                    configService.get<string>('SANDBOX_PROVIDER') || 'auto';

                // Explicit selection respected first.
                if (provider === 'null') {
                    return new NullSandboxProvider();
                }
                if (provider === 'local') {
                    return new LocalSandboxService(configService);
                }
                if (provider === 'e2b') {
                    return new E2BSandboxService(configService, egressProbe);
                }

                // 'auto' (default): prefer E2B when an API key is configured,
                // otherwise fall back to LocalSandbox so self-hosted instances
                // still get native tools (grep, readFile, listDir) for both
                // review and conversation. NullSandbox is reserved for
                // explicit `SANDBOX_PROVIDER=null` (test environments).
                if (configService.get<string>('API_E2B_KEY')) {
                    return new E2BSandboxService(configService, egressProbe);
                }
                return new LocalSandboxService(configService);
            },
            inject: [ConfigService, SandboxEgressProbeService],
        },
        SandboxLeaseRepository,
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
