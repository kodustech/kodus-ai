import { CodeReviewFeedbackEntity } from '@/core/domain/codeReviewFeedback/entities/codeReviewFeedback.entity';
import { ICodeReviewFeedback } from '@/core/domain/codeReviewFeedback/interfaces/codeReviewFeedback.interface';
import { CodeReviewFeedbackService } from '@/core/infrastructure/adapters/services/codeReviewFeedback/codeReviewFeedback.service';
import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import { IUseCase } from '@/shared/domain/interfaces/use-case.interface';
import { Inject, Injectable } from '@nestjs/common';
import { CODE_REVIEW_FEEDBACK_SERVICE_TOKEN } from '@/core/domain/codeReviewFeedback/contracts/codeReviewFeedback.service.contract';
import { PinoLoggerService } from '@/core/infrastructure/adapters/services/logger/pino.service';
import { GetReactionsUseCase } from './get-reactions.use-case';

@Injectable()
export class SaveCodeReviewFeedbackUseCase implements IUseCase {
    constructor(
        @Inject(CODE_REVIEW_FEEDBACK_SERVICE_TOKEN)
        private readonly codeReviewFeedbackService: CodeReviewFeedbackService,
        private readonly getReactionsUseCase: GetReactionsUseCase,
        private readonly logger: PinoLoggerService,
    ) {}

    async execute(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<CodeReviewFeedbackEntity[]> {
        try {
            const reactions = await this.getReactions(organizationAndTeamData);

            return await this.codeReviewFeedbackService.bulkCreate(
                reactions as Omit<ICodeReviewFeedback, 'uuid'>[],
            );
        } catch (error) {
            this.logger.error({
                message: 'Error save code review feedback',
                context: SaveCodeReviewFeedbackUseCase.name,
                error,
                metadata: { organizationAndTeamData },
            });
            throw error;
        }
    }

    private async getReactions(
        organizationAndTeamData: OrganizationAndTeamData,
    ) {
        return this.getReactionsUseCase.execute(organizationAndTeamData);
    }
}
