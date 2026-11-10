import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { createLogger } from '@libs/core/log/logger';

import { RedriveRuntimePublicationsUseCase } from '../application/redrive-runtime-publications.use-case';

// Every minute: a lost final publication is re-driven within about
// REDRIVE_AFTER_MS plus a minute. Each replica sweeps; rows are reserved one
// by one, so two replicas never drive the same row.
const RUNTIME_CRON_PUBLICATION_REDRIVE =
    process.env.RUNTIME_CRON_PUBLICATION_REDRIVE || '* * * * *';

/** Runs the redrive sweep of the Runtime publications in the code-review worker. */
@Injectable()
export class RuntimePublicationRedriveCron {
    private readonly logger = createLogger(RuntimePublicationRedriveCron.name);
    private running = false;

    constructor(private readonly redrive: RedriveRuntimePublicationsUseCase) {}

    @Cron(RUNTIME_CRON_PUBLICATION_REDRIVE, { name: 'Runtime publication redrive' })
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
