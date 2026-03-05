import { forwardRef, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { CODE_REVIEW_FEEDBACK_REPOSITORY_TOKEN } from '@libs/code-review/domain/codeReviewFeedback/contracts/codeReviewFeedback.repository';
import { CODE_REVIEW_FEEDBACK_SERVICE_TOKEN } from '@libs/code-review/domain/codeReviewFeedback/contracts/codeReviewFeedback.service.contract';
import { CodeReviewFeedbackRepository } from '@libs/code-review/infrastructure/adapters/repositories/codeReviewFeedback.repository';
import { CodeReviewFeedbackService } from '@libs/code-review/infrastructure/adapters/services/codeReviewFeedback.service';

import {
    CodeReviewFeedbackModel,
    CodeReviewFeedbackSchema,
} from '@libs/code-review/infrastructure/adapters/repositories/schemas/mongoose/codeReviewFeedback.model';
import { UserModule } from '@libs/identity/modules/user.module';
import { IntegrationCoreModule } from '@libs/integrations/modules/integrations-core.module';
import { IntegrationConfigCoreModule } from '@libs/integrations/modules/config-core.module';
import { ParametersModule } from '@libs/organization/modules/parameters.module';
import { TeamModule } from '@libs/organization/modules/team.module';
import { OrganizationModule } from '@libs/organization/modules/organization.module';
import { GithubModule } from '@libs/platform/modules/github.module';
import { GitlabModule } from '@libs/platform/modules/gitlab.module';
import { PlatformModule } from '@libs/platform/modules/platform.module';
import { PullRequestsModule } from './pull-requests.module';
import { GetReactionsUseCase } from '../application/use-cases/codeReviewFeedback/get-reactions.use-case';
import { SaveCodeReviewFeedbackUseCase } from '../application/use-cases/codeReviewFeedback/save-feedback.use-case';
import { CodeReviewFeedbackConsumer } from '@libs/core/infrastructure/queue/messageBroker/consumers/codeReviewFeedback.consumer';
import { CodebaseModule } from '../modules/codebase.module';

const UseCases = [GetReactionsUseCase, SaveCodeReviewFeedbackUseCase] as const;

@Module({
    imports: [
        MongooseModule.forFeature([
            {
                name: CodeReviewFeedbackModel.name,
                schema: CodeReviewFeedbackSchema,
            },
        ]),
        forwardRef(() => TeamModule),
        forwardRef(() => OrganizationModule),
        forwardRef(() => UserModule),
        forwardRef(() => PlatformModule),
        forwardRef(() => IntegrationCoreModule),
        forwardRef(() => IntegrationConfigCoreModule),
        forwardRef(() => ParametersModule),
        forwardRef(() => GithubModule),
        forwardRef(() => GitlabModule),
        forwardRef(() => PullRequestsModule),
        forwardRef(() => CodebaseModule),
    ],
    providers: [
        ...UseCases,
        {
            provide: CODE_REVIEW_FEEDBACK_REPOSITORY_TOKEN,
            useClass: CodeReviewFeedbackRepository,
        },
        {
            provide: CODE_REVIEW_FEEDBACK_SERVICE_TOKEN,
            useClass: CodeReviewFeedbackService,
        },
        CodeReviewFeedbackConsumer,
    ],
    exports: [
        CODE_REVIEW_FEEDBACK_REPOSITORY_TOKEN,
        CODE_REVIEW_FEEDBACK_SERVICE_TOKEN,
        ...UseCases,
        CodeReviewFeedbackConsumer,
    ],
    controllers: [],
})
export class CodeReviewFeedbackModule {}
