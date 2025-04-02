import { GetCodeReviewFeedbackByOrganizationUseCase } from '@/core/application/use-cases/codeReviewFeedback/get-feedback-by-organization.use-case';
import { SaveCodeReviewFeedbackUseCase } from '@/core/application/use-cases/codeReviewFeedback/save-feedback.use-case';
import { CodeReviewFeedbackEntity } from '@/core/domain/codeReviewFeedback/entities/codeReviewFeedback.entity';
import { Body, Controller, Get, Param, Post } from '@nestjs/common';

@Controller('code-review-feedback')
export class CodeReviewFeedbackController {
    constructor(
        private readonly getCodeReviewFeedbackByOrganizationUseCase: GetCodeReviewFeedbackByOrganizationUseCase,
        private readonly saveCodeReviewFeedbackUseCase: SaveCodeReviewFeedbackUseCase,
    ) {}

    @Get('organization/:organizationId')
    async getByOrganizationId(
        @Param('organizationId') organizationId: string,
    ): Promise<CodeReviewFeedbackEntity[]> {
        return await this.getCodeReviewFeedbackByOrganizationUseCase.execute(
            organizationId,
        );
    }

    @Post('reactions')
    async saveReactions(
        @Body() body: { organizationId: string; teamId: string },
    ): Promise<CodeReviewFeedbackEntity[]> {
        return await this.saveCodeReviewFeedbackUseCase.execute({
            organizationId: body.organizationId,
            teamId: body.teamId,
        });
    }
}
