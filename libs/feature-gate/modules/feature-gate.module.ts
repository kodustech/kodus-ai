import { Global, Module } from '@nestjs/common';

import { TelemetryModule } from '@libs/telemetry/modules/telemetry.module';

import {
    FEATURE_GATE_SERVICE_TOKEN,
    FeatureGateService,
} from '../application/feature-gate.service';

@Global()
@Module({
    // `FeatureGateService` injects `POSTHOG_PROVIDER_TOKEN`, which is
    // registered by `TelemetryModule`. Even though both modules are
    // `@Global()`, making the dependency explicit here removes the boot
    // race where `FeatureGateService` could be instantiated before
    // `TelemetryModule` had registered the token (observed in the
    // webhooks app — `UnknownDependenciesException` at startup).
    imports: [TelemetryModule],
    providers: [
        FeatureGateService,
        {
            provide: FEATURE_GATE_SERVICE_TOKEN,
            useExisting: FeatureGateService,
        },
    ],
    exports: [FeatureGateService, FEATURE_GATE_SERVICE_TOKEN],
})
export class FeatureGateModule {}
