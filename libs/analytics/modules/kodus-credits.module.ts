import { forwardRef, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { LicenseModule } from '@libs/ee/license/license.module';
import { OrganizationParametersModule } from '@libs/organization/modules/organizationParameters.module';

import {
    KODUS_CREDITS_METERING_SERVICE_TOKEN,
    KodusCreditsMeteringService,
} from '../application/credits/kodus-credits-metering.service';
import {
    KodusCreditChargeModel,
    KodusCreditChargeModelSchema,
    KodusCreditSweepStateModel,
    KodusCreditSweepStateModelSchema,
} from '../infrastructure/adapters/repositories/schemas/kodusCreditCharge.model';
import {
    ObservabilityTelemetryModel,
    ObservabilityTelemetryModelSchema,
} from '../infrastructure/adapters/repositories/schemas/observabilityTelemetry.model';

/**
 * Metering for "Kodus as the provider": journals Kodus-routed usage spans as
 * charges and debits them from the org's prepaid balance (billing service).
 * Driven by the sweep cron in apps/api; the journal read serves the UI.
 */
@Module({
    imports: [
        MongooseModule.forFeature([
            {
                name: ObservabilityTelemetryModel.name,
                schema: ObservabilityTelemetryModelSchema,
            },
            {
                name: KodusCreditChargeModel.name,
                schema: KodusCreditChargeModelSchema,
            },
            {
                name: KodusCreditSweepStateModel.name,
                schema: KodusCreditSweepStateModelSchema,
            },
        ]),
        forwardRef(() => OrganizationParametersModule),
        forwardRef(() => LicenseModule),
    ],
    providers: [
        {
            provide: KODUS_CREDITS_METERING_SERVICE_TOKEN,
            useClass: KodusCreditsMeteringService,
        },
    ],
    exports: [KODUS_CREDITS_METERING_SERVICE_TOKEN],
})
export class KodusCreditsModule {}
