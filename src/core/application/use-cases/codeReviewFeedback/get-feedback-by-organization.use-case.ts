import { CodeReviewFeedbackEntity } from '@/core/domain/codeReviewFeedback/entities/codeReviewFeedback.entity';
import { CodeReviewFeedbackService } from '@/core/infrastructure/adapters/services/codeReviewFeedback/codeReviewFeedback.service';
import { IUseCase } from '@/shared/domain/interfaces/use-case.interface';

export class GetCodeReviewFeedbackByOrganizationUseCase implements IUseCase {
    constructor(
        private readonly codeReviewFeedbackService: CodeReviewFeedbackService,
    ) {}

    async execute(organizationId: string): Promise<CodeReviewFeedbackEntity[]> {
        return await this.codeReviewFeedbackService.getByOrganizationId(
            organizationId,
        );
    }
}
