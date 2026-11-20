import { Injectable } from '@nestjs/common';
import { GatedCron } from '@libs/core/infrastructure/services/cron-run-gate';
import { RUNTIME_CRON_SCHEDULES } from '@libs/runtime/api/infrastructure/runtime-cron-schedules';

import { createLogger } from '@libs/core/log/logger';

import { RedriveRuntimePublicationsUseCase } from '../application/redrive-runtime-publications.use-case';

// Every minute: a lost final publication is re-driven within about
// REDRIVE_AFTER_MS plus a minute. Each replica sweeps; rows are reserved one
// by one, so two replicas never drive the same row.

/** Runs the redrive sweep of the Runtime publications in the code-review worker. */
@Injectable()
export class RuntimePublicationRedriveCron {
    private readonly logger = createLogger(RuntimePublicationRedriveCron.name);
    private running = false;

    constructor(private readonly redrive: RedriveRuntimePublicationsUseCase) {}

    @GatedCron(RUNTIME_CRON_SCHEDULES.publicationRedrive, { name: 'Runtime publication redrive' })
    async handleCron(): Promise<void> {
        // A slow sweep (a platform answering slowly) never overlaps the next tick.
        if (this.running) return;
        this.running = true;
        try {
            const out = await this.redrive.sweep();
            if (out.stuck) {
                this.logger.log({
                    message: 'Runtime publication redrive: sweep',
                    context: RuntimePublicationRedriveCron.name,
                    metadata: out,
                });
            }
        } catch (error) {
            this.logger.error({
                message: 'Runtime publication redrive: sweep failed',
                context: RuntimePublicationRedriveCron.name,
                error: error instanceof Error ? error : undefined,
            });
        } finally {
            this.running = false;
        }
    }
}
