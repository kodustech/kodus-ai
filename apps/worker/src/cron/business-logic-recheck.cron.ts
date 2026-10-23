import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { createLogger } from '@libs/core/log/logger';
import { BusinessLogicRecheckService } from '@libs/platform/application/services/business-logic-recheck.service';

/**
 * Re-checks PRs whose Business Logic validation was skipped because the task
 * tracker was down (UC-22), every 15 minutes. Each run is claimed before it
 * is re-checked, so several workers never re-check the same PR.
 */
@Injectable()
export class BusinessLogicRecheckCron {
    private readonly logger = createLogger(BusinessLogicRecheckCron.name);
    private running = false;

    constructor(private readonly recheck: BusinessLogicRecheckService) {}

    @Cron('*/15 * * * *', {
        name: 'business-logic-recheck',
        timeZone: 'UTC',
    })
    async handle(): Promise<void> {
        if (this.running) {
            return;
        }
        this.running = true;
        try {
            const count = await this.recheck.recheckPending();
            if (count) {
                this.logger.log({
                    message: `Business logic re-checked ${count} PR(s)`,
                    context: BusinessLogicRecheckCron.name,
                    metadata: { job: 'business-logic-recheck', count },
                });
            }
        } catch (error) {
            this.logger.warn({
                message: 'Business logic re-check failed',
                context: BusinessLogicRecheckCron.name,
                error,
                metadata: { job: 'business-logic-recheck' },
            });
        } finally {
            this.running = false;
        }
    }
}
