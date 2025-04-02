import { PinoLoggerService } from '@/core/infrastructure/adapters/services/logger/pino.service';
import { forwardRef, Module } from '@nestjs/common';
import { IntegrationModule } from './integration.module';
import { IntegrationConfigModule } from './integrationConfig.module';
import { COMMENT_MANAGER_SERVICE_TOKEN } from '@/core/domain/codeBase/contracts/CommentManagerService.contract';
import { CommentManagerService } from '@/core/infrastructure/adapters/services/codeBase/commentManager.service';
import { ParametersModule } from './parameters.module';
import { PlatformIntegrationModule } from './platformIntegration.module';
import { PULL_REQUEST_MANAGER_SERVICE_TOKEN } from '@/core/domain/codeBase/contracts/PullRequestManagerService.contract';
import { PullRequestHandlerService } from '@/core/infrastructure/adapters/services/codeBase/pullRequestManager.service';
import { AutomationStrategyModule } from './automationStrategy.module';
import { AutomationModule } from './automation.module';
import { CODE_BASE_CONFIG_SERVICE_TOKEN } from '@/core/domain/codeBase/contracts/CodeBaseConfigService.contract';
import {
    LLM_ANALYSIS_SERVICE_TOKEN,
    LLMAnalysisService,
} from '@/core/infrastructure/adapters/services/codeBase/llmAnalysis.service';
import { TeamsModule } from './team.module';
import { CodeReviewHandlerService } from '@/core/infrastructure/adapters/services/codeBase/codeReviewHandlerService.service';
import { KodyRulesModule } from './kodyRules.module';
import { AstModule } from './ast.module';
import { PullRequestsModule } from './pullRequests.module';
import { SUGGESTION_SERVICE_TOKEN } from '@/core/domain/codeBase/contracts/SuggestionService.contract';
import { SuggestionEmbeddedModule } from './suggestionEmbedded.module';
import { OrganizationParametersModule } from './organizationParameters.module';
import { PromptRunnerService } from '@/core/infrastructure/adapters/services/codeBase/promptRunner.service';
import { CommentAnalysisService } from '@/core/infrastructure/adapters/services/codeBase/commentAnalysis.service';
import { CodeReviewFeedbackModule } from './codeReviewFeedback.module';

import { UseCases } from '@/core/application/use-cases/codeBase';
import { REPOSITORY_MANAGER_TOKEN } from '@/core/domain/repository/contracts/repository-manager.contract';
import { RepositoryManagerService } from '@/core/infrastructure/adapters/services/codeBase/repository/repository-manager.service';
import { AST_ANALYSIS_SERVICE_TOKEN } from '@/core/domain/codeBase/contracts/ASTAnalysisService.contract';
import { SuggestionService } from '@/core/infrastructure/adapters/services/codeBase/suggestion.service';
import { PromptService } from '@/core/infrastructure/adapters/services/prompt.service';
import { CodeBaseController } from '@/core/infrastructure/http/controllers/codeBase.controller';
import { KodyFineTuningService } from '@/ee/kodyFineTuning/kodyFineTuning.service';
import { CodeReviewPipelineModule } from './codeReviewPipeline.module';
import { FileReviewModule } from '@/ee/codeReview/fileReviewContextPreparation/fileReview.module';
import { PipelineModule } from './pipeline.module';
import { KodyFineTuningContextModule } from '@/ee/kodyFineTuning/fineTuningContext/kodyFineTuningContext.module';
import { KodyASTAnalyzeContextModule } from '@/ee/kodyASTAnalyze/kodyAstAnalyzeContext.module';
import CodeBaseConfigService from '@/ee/codeBase/codeBaseConfig.service';
import { CodeAnalysisOrchestrator } from '@/ee/codeBase/codeAnalysisOrchestrator.service';
import { DiffAnalyzerService } from '@/ee/codeBase/diffAnalyzer.service';
import { CodeAstAnalysisService } from '@/ee/codeBase/codeASTAnalysis.service';
import { KODY_RULES_ANALYSIS_SERVICE_TOKEN, KodyRulesAnalysisService } from '@/ee/codeBase/kodyRulesAnalysis.service';
import { GlobalParametersModule } from './global-parameters.module';

@Module({
    imports: [
        forwardRef(() => IntegrationModule),
        forwardRef(() => IntegrationConfigModule),
        forwardRef(() => ParametersModule),
        forwardRef(() => PlatformIntegrationModule),
        forwardRef(() => AutomationStrategyModule),
        forwardRef(() => AutomationModule),
        forwardRef(() => TeamsModule),
        forwardRef(() => KodyRulesModule),
        forwardRef(() => AstModule),
        forwardRef(() => PullRequestsModule),
        forwardRef(() => SuggestionEmbeddedModule),
        forwardRef(() => OrganizationParametersModule),
        forwardRef(() => CodeReviewFeedbackModule),
        forwardRef(() => FileReviewModule),
        forwardRef(() => CodeReviewPipelineModule),
        forwardRef(() => PipelineModule),
        forwardRef(() => KodyFineTuningContextModule),
        forwardRef(() => KodyASTAnalyzeContextModule),
        forwardRef(() => GlobalParametersModule),
    ],
    providers: [
        ...UseCases,
        {
            provide: LLM_ANALYSIS_SERVICE_TOKEN,
            useClass: LLMAnalysisService,
        },
        {
            provide: CODE_BASE_CONFIG_SERVICE_TOKEN,
            useClass: CodeBaseConfigService,
        },
        {
            provide: PULL_REQUEST_MANAGER_SERVICE_TOKEN,
            useClass: PullRequestHandlerService,
        },
        {
            provide: COMMENT_MANAGER_SERVICE_TOKEN,
            useClass: CommentManagerService,
        },
        {
            provide: KODY_RULES_ANALYSIS_SERVICE_TOKEN,
            useClass: KodyRulesAnalysisService,
        },
        {
            provide: REPOSITORY_MANAGER_TOKEN,
            useClass: RepositoryManagerService,
        },
        {
            provide: AST_ANALYSIS_SERVICE_TOKEN,
            useClass: CodeAstAnalysisService,
        },
        {
            provide: SUGGESTION_SERVICE_TOKEN,
            useClass: SuggestionService,
        },
        DiffAnalyzerService,
        PromptService,
        CodeAnalysisOrchestrator,
        PinoLoggerService,
        CodeReviewHandlerService,
        KodyFineTuningService,
        PromptRunnerService,
        CommentAnalysisService,
    ],
    exports: [
        PULL_REQUEST_MANAGER_SERVICE_TOKEN,
        LLM_ANALYSIS_SERVICE_TOKEN,
        AST_ANALYSIS_SERVICE_TOKEN,
        COMMENT_MANAGER_SERVICE_TOKEN,
        CODE_BASE_CONFIG_SERVICE_TOKEN,
        KODY_RULES_ANALYSIS_SERVICE_TOKEN,
        REPOSITORY_MANAGER_TOKEN,
        SUGGESTION_SERVICE_TOKEN,
        PromptService,
        CodeAnalysisOrchestrator,
        KodyFineTuningService,

        CodeReviewHandlerService,
        CommentAnalysisService,
        DiffAnalyzerService,
    ],
    controllers: [CodeBaseController],
})
export class CodebaseModule { }
