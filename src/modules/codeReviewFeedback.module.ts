import { SaveCodeReviewFeedbackUseCase } from '@/core/application/use-cases/codeReviewFeedback/save-feedback.use-case';
import { CODE_REVIEW_FEEDBACK_REPOSITORY_TOKEN } from '@/core/domain/codeReviewFeedback/contracts/codeReviewFeedback.repository';
import { CODE_REVIEW_FEEDBACK_SERVICE_TOKEN } from '@/core/domain/codeReviewFeedback/contracts/codeReviewFeedback.service.contract';
import { CodeReviewFeedbackRepository } from '@/core/infrastructure/adapters/repositories/mongoose/codeReviewFeedback.repository';
import { CodeReviewFeedbackModelInstance } from '@/core/infrastructure/adapters/repositories/mongoose/schema';
import { CodeReviewFeedbackService } from '@/core/infrastructure/adapters/services/codeReviewFeedback/codeReviewFeedback.service';
import { forwardRef, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { TeamsModule } from './team.module';
import { OrganizationModule } from './organization.module';
import { UsersModule } from './user.module';
import { PlatformIntegrationModule } from './platformIntegration.module';
import { IntegrationModule } from './integration.module';
import { IntegrationConfigModule } from './integrationConfig.module';
import { ParametersModule } from './parameters.module';
import { PromptService } from '@/core/infrastructure/adapters/services/prompt.service';
import { GithubModule } from './github.module';
import { GitlabModule } from './gitlab.module';
import { CodeReviewFeedbackController } from '@/core/infrastructure/http/controllers/codeReviewFeedback.controller';
import { GetCodeReviewFeedbackByOrganizationUseCase } from '@/core/application/use-cases/codeReviewFeedback/get-feedback-by-organization.use-case';
import { GetReactionsUseCase } from '@/core/application/use-cases/codeReviewFeedback/get-reactions.use-case';
import { PullRequestsModule } from './pullRequests.module';
import { LogModule } from './log.module';

const UseCases = [
    GetReactionsUseCase,
    GetCodeReviewFeedbackByOrganizationUseCase,
    SaveCodeReviewFeedbackUseCase,
] as const;

@Module({
    imports: [
        MongooseModule.forFeature([CodeReviewFeedbackModelInstance]),
        forwardRef(() => TeamsModule),
        forwardRef(() => OrganizationModule),
        forwardRef(() => UsersModule),
        forwardRef(() => PlatformIntegrationModule),
        forwardRef(() => IntegrationModule),
        forwardRef(() => IntegrationConfigModule),
        forwardRef(() => ParametersModule),
        forwardRef(() => GithubModule),
        forwardRef(() => GitlabModule),
        forwardRef(() => PullRequestsModule),
        LogModule,
    ],
    providers: [
        ...UseCases,
        PromptService,

        {
            provide: CODE_REVIEW_FEEDBACK_REPOSITORY_TOKEN,
            useClass: CodeReviewFeedbackRepository,
        },
        {
            provide: CODE_REVIEW_FEEDBACK_SERVICE_TOKEN,
            useClass: CodeReviewFeedbackService,
        },
    ],
    exports: [
        CODE_REVIEW_FEEDBACK_REPOSITORY_TOKEN,
        CODE_REVIEW_FEEDBACK_SERVICE_TOKEN,
        ...UseCases,
    ],
    controllers: [CodeReviewFeedbackController],
})
export class CodeReviewFeedbackModule {}
