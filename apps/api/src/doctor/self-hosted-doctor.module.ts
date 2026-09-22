import { Module } from '@nestjs/common';

import { CockpitModule } from '@libs/cockpit/modules/cockpit.module';
import { LicenseModule } from '@libs/ee/license/license.module';
import { PermissionValidationModule } from '@libs/ee/shared/permission-validation.module';
import { PlatformCoreModule } from '@libs/platform/modules/platform-core.module';

import { SelfHostedDoctorService } from './self-hosted-doctor.service';

@Module({
    imports: [
        PlatformCoreModule,
        PermissionValidationModule,
        LicenseModule,
        CockpitModule,
    ],
    providers: [SelfHostedDoctorService],
    exports: [SelfHostedDoctorService],
})
export class SelfHostedDoctorModule {}
