import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { environment } from '@libs/ee/configs/environment';
import {
    ISelfHostedBeaconService,
    SELF_HOSTED_BEACON_SERVICE_TOKEN,
} from '@libs/telemetry/application/services/self-hosted-beacon.service';

/**
 * Daily anonymous heartbeat for self-hosted instances. Sends one POST per
 * UTC day to the `kodus-beacon` receiver (telemetry.kodus.io); the service
 * itself owns dedupe, opt-out, and `instance_id` persistence.
 *
 * Schedule: 03:17 UTC daily — the odd minute is intentional jitter so the
 * global fleet doesn't stampede the receiver at the top of the hour.
 *
 * Scope: self-hosted only. Cloud already has rich product telemetry via
 * PostHog/Resend/n8n; the cloud control plane has no use for its own
 * heartbeat. Skip on cloud entirely.
 *
 * Boot transparency: on first init in self-hosted mode, log a single line
 * announcing the telemetry state and how to inspect / disable it. This is
 * the highest-leverage trust signal — operators see it the first time they
 * boot the worker, without having to read docs.
 */
@Injectable()
export class SelfHostedBeaconCron implements OnModuleInit {
    private readonly logger = new Logger(SelfHostedBeaconCron.name);

    constructor(
        @Inject(SELF_HOSTED_BEACON_SERVICE_TOKEN)
        private readonly beacon: ISelfHostedBeaconService,
    ) {}

    onModuleInit(): void {
        // Defensive: this is a transparency log, never a critical path.
        // Anything throwing here would abort module boot and brick the
        // worker — which violates the "telemetry never breaks the host"
        // contract. Swallow everything.
        try {
            if (environment.API_CLOUD_MODE) {
                return;
            }

            if (this.beacon.isDisabled()) {
                this.logger.log(
                    'Anonymous usage telemetry is DISABLED (KODUS_TELEMETRY_DISABLED is set). No heartbeat will be sent.',
                );
                return;
            }

            this.logger.log(
                'Anonymous usage telemetry is enabled. One heartbeat per UTC day to telemetry.kodus.io with aggregated counters only — no code, names, or identifiers. Inspect with `yarn telemetry:preview`. Disable with KODUS_TELEMETRY_DISABLED=true. Schema: https://github.com/kodustech/kodus-beacon/blob/main/docs/api.md',
            );
        } catch {
            // Even logging is best-effort here. If the logger itself is
            // somehow broken we'd rather lose the boot message than crash
            // the worker.
        }
    }

    @Cron('17 3 * * *', {
        name: 'self-hosted-beacon',
        timeZone: 'UTC',
    })
    async handle(): Promise<void> {
        if (environment.API_CLOUD_MODE) {
            return;
        }

        const start = Date.now();
        await this.beacon.run();
        this.logger.log(
            `self-hosted beacon done in ${Date.now() - start}ms`,
        );
    }
}
