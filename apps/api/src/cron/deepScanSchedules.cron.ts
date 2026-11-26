import { Injectable } from '@nestjs/common';

import { GatedCron } from '@libs/core/infrastructure/services/cron-run-gate';
import { createLogger } from '@libs/core/log/logger';
import { SecurityScanSchedulesUseCase } from '@libs/security-scan/application/security-scan-schedules.use-case';

const API_CRON_DEEP_SCAN_SCHEDULES =
    process.env.API_CRON_DEEP_SCAN_SCHEDULES || '*/15 * * * *';

/**
 * Starts the deep scans their schedules have due. Every API instance runs it:
 * each schedule is claimed before it starts, so none starts twice.
 */
@Injectable()
export class DeepScanSchedulesCronProvider {
    private readonly logger = createLogger(DeepScanSchedulesCronProvider.name);

    constructor(private readonly schedules: SecurityScanSchedulesUseCase) {}

    @GatedCron(API_CRON_DEEP_SCAN_SCHEDULES, {
        name: 'Deep scan schedules',
    })
    async handleCron(): Promise<void> {
        try {
            const started = await this.schedules.runDue();
            if (started > 0) {
                this.logger.log({
                    message: 'Scheduled deep scans started',
                    context: DeepScanSchedulesCronProvider.name,
                    metadata: { started },
                });
            }
        } catch (error) {
            this.logger.error({
                message: 'Could not run the due deep scan schedules',
                context: DeepScanSchedulesCronProvider.name,
                error: error instanceof Error ? error : undefined,
            });
        }
    }
}
