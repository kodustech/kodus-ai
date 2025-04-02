import { Injectable } from '@nestjs/common';
import { PinoLoggerService } from '@/core/infrastructure/adapters/services/logger/pino.service';
import * as labelsData from '@/core/infrastructure/adapters/services/automation/processAutomation/config/codeReview/labels.json';

@Injectable()
export class ListCodeReviewAutomationLabelsUseCase {
    constructor(private readonly logger: PinoLoggerService) {}

    execute() {
        try {
            return labelsData;
        } catch (error) {
            this.logger.error({
                message: 'Error listing code review automation labels',
                context: ListCodeReviewAutomationLabelsUseCase.name,
                error: error,
            });
            throw new Error('Error listing code review automation labels');
        }
    }
}
