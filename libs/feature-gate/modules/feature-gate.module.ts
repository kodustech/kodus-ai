import { Global, Module } from '@nestjs/common';

import { TelemetryModule } from '@libs/telemetry/modules/telemetry.module';

import { FeatureGateService } from '../application/feature-gate.service';

@Global()
@Module({
    // `FeatureGateService` injects `POSTHOG_PROVIDER_TOKEN`, which is
    // registered by `TelemetryModule`. Even though both modules are
    // `@Global()`, making the dependency explicit here removes the boot
    // race where `FeatureGateService` could be instantiated before
    // `TelemetryModule` had registered the token (observed in the
    // webhooks app — `UnknownDependenciesException` at startup).
    imports: [TelemetryModule],
    providers: [FeatureGateService],
    exports: [FeatureGateService],
})
export class FeatureGateModule {}
