import { forwardRef, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';

import { SANDBOX_PROVIDER_TOKEN } from '@libs/sandbox/domain/contracts/sandbox.provider';
import { SANDBOX_LEASE_MANAGER_TOKEN } from '@libs/sandbox/domain/contracts/sandbox-lease-manager.contract';
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
    type ISandboxEgressPolicy,
    SANDBOX_EGRESS_POLICY_TOKEN,
    SandboxEgressPolicyService,
} from '@libs/sandbox/infrastructure/services/sandbox-egress-policy.service';
import { SandboxCapacityModule } from '@libs/sandbox/modules/sandbox-capacity.module';
import { selectSandboxProvider } from '@libs/sandbox/modules/select-sandbox-provider';
import { GlobalParametersModule } from '@libs/organization/modules/global-parameters.module';
import { OrganizationParametersModule } from '@libs/organization/modules/organizationParameters.module';
import { LicenseModule } from '@libs/ee/license/license.module';

@Module({
    imports: [
        MongooseModule.forFeature([
            { name: SandboxLeaseModel.name, schema: SandboxLeaseSchema },
        ]),
        SandboxCapacityModule,
        GlobalParametersModule,
        // The organization's fixed outbound IP choice is an organization
        // parameter.
        forwardRef(() => OrganizationParametersModule),
        // The plan decides whether a team may keep the fixed outbound IP.
        forwardRef(() => LicenseModule),
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
    exports: [
        SANDBOX_PROVIDER_TOKEN,
        SANDBOX_LEASE_MANAGER_TOKEN,
        SANDBOX_EGRESS_POLICY_TOKEN,
    ],
})
export class SandboxModule {}
