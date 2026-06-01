/**
 * @license
 * Kodus Tech. All rights reserved.
 */

import { forwardRef, Module } from '@nestjs/common';

import { TeamModule } from '@libs/organization/modules/team.module';

import { EnterpriseTierGuard } from './guards/enterprise-tier.guard';
import { LICENSE_SERVICE_TOKEN } from './interfaces/license.interface';
import { LicenseService } from './license.service';
import { SelfHostedLicenseService } from './self-hosted-license.service';
import { AutoAssignLicenseUseCase } from './use-cases/auto-assign-license.use-case';
import { OrganizationParametersModule } from '@libs/organization/modules/organizationParameters.module';
import { environment } from '@libs/ee/configs/environment';

@Module({
    imports: [
        forwardRef(() => TeamModule),
        forwardRef(() => OrganizationParametersModule),
    ],
    providers: [
        LicenseService,
        SelfHostedLicenseService,
        {
            provide: LICENSE_SERVICE_TOKEN,
            useFactory: (
                cloudService: LicenseService,
                selfHostedService: SelfHostedLicenseService,
            ) => {
                return environment.API_CLOUD_MODE
                    ? cloudService
                    : selfHostedService;
            },
            inject: [LicenseService, SelfHostedLicenseService],
        },
        AutoAssignLicenseUseCase,
        EnterpriseTierGuard,
    ],
    exports: [
        LicenseService,
        SelfHostedLicenseService,
        LICENSE_SERVICE_TOKEN,
        AutoAssignLicenseUseCase,
        EnterpriseTierGuard,
    ],
})
export class LicenseModule {}
