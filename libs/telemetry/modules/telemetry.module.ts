import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { TelemetryService } from '../application/services/telemetry.service';
import { N8nProvider } from '../infrastructure/providers/n8n.provider';
import {
    POSTHOG_PROVIDER_TOKEN,
    PostHogProvider,
} from '../infrastructure/providers/posthog.provider';
import { ResendEventsProvider } from '../infrastructure/providers/resend-events.provider';

@Global()
@Module({
    imports: [ConfigModule],
    providers: [
        // Provide PostHog via the symbolic token AND keep the concrete
        // class registered so existing places that already import the
        // class directly keep working until the migration lands. New
        // consumers should `@Inject(POSTHOG_PROVIDER_TOKEN)`.
        PostHogProvider,
        {
            provide: POSTHOG_PROVIDER_TOKEN,
            useExisting: PostHogProvider,
        },
        ResendEventsProvider,
        N8nProvider,
        TelemetryService,
    ],
    exports: [
        TelemetryService,
        PostHogProvider,
        POSTHOG_PROVIDER_TOKEN,
    ],
})
export class TelemetryModule {}
