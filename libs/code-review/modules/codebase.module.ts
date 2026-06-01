import { AIEngineModule } from '@libs/ai-engine/modules/ai-engine.module';
import { CodeAnalysisOrchestrator } from '@libs/ee/codeBase/codeAnalysisOrchestrator.service';
import { SandboxModule } from '@libs/sandbox/modules/sandbox.module';
import { forwardRef, Module } from '@nestjs/common';

import { CodeReviewFeedbackModule } from '@libs/code-review/modules/codeReviewFeedback.module';
import { ContextReferenceModule } from '@libs/code-review/modules/contextReference.module';
import { PullRequestsModule } from '@libs/code-review/modules/pull-requests.module';
import { CodeReviewPipelineModule } from '@libs/code-review/pipeline/code-review-pipeline.module';
import { TokenChunkingModule } from '@libs/core/infrastructure/services/tokenChunking/tokenChunking.module';
import CodeBaseConfigService from '@libs/ee/codeBase/codeBaseConfig.service';
import {
    KODY_RULES_ANALYSIS_SERVICE_TOKEN,
    KodyRulesAnalysisService,
} from '@libs/ee/codeBase/kodyRulesAnalysis.service';
import {
    KODY_RULES_PR_LEVEL_ANALYSIS_SERVICE_TOKEN,
    KodyRulesPrLevelAnalysisService,
} from '@libs/ee/codeBase/kodyRulesPrLevelAnalysis.service';
import { FileReviewModule } from '@libs/ee/codeReview/fileReviewContextPreparation/fileReview.module';
import { LicenseModule } from '@libs/ee/license/license.module';
import { PermissionValidationModule } from '@libs/ee/shared/permission-validation.module';
import { IntegrationConfigCoreModule } from '@libs/integrations/modules/config-core.module';
import { IntegrationCoreModule } from '@libs/integrations/modules/integrations-core.module';
import { KodyFineTuningService } from '@libs/kodyFineTuning/infrastructure/adapters/services/kodyFineTuning.service';
import { KodyFineTuningContextModule } from '@libs/kodyFineTuning/kodyFineTuningContext.module';
import { SuggestionEmbeddedModule } from '@libs/kodyFineTuning/suggestionEmbedded.module';
import { KodyRulesModule } from '@libs/kodyRules/modules/kodyRules.module';
import { GlobalParametersModule } from '@libs/organization/modules/global-parameters.module';
import { ParametersModule } from '@libs/organization/modules/parameters.module';
import { TeamModule } from '@libs/organization/modules/team.module';
import { PlatformModule } from '@libs/platform/modules/platform.module';
import { CODE_BASE_CONFIG_SERVICE_TOKEN } from '../domain/contracts/CodeBaseConfigService.contract';
import { COMMENT_MANAGER_SERVICE_TOKEN } from '../domain/contracts/CommentManagerService.contract';
import { PULL_REQUEST_MANAGER_SERVICE_TOKEN } from '../domain/contracts/PullRequestManagerService.contract';
import { SUGGESTION_SERVICE_TOKEN } from '../domain/contracts/SuggestionService.contract';
import {
    CODEBASE_SEARCH_SERVICE_TOKEN,
    CodebaseSearchService,
} from '../infrastructure/adapters/services/codebaseSearch.service';
import { CodeReviewHandlerService } from '../infrastructure/adapters/services/codeReviewHandlerService.service';
import {
    COLLECT_CROSS_FILE_CONTEXTS_SERVICE_TOKEN,
    CollectCrossFileContextsService,
} from '../infrastructure/adapters/services/collectCrossFileContexts.service';
import { CommentAnalysisService } from '../infrastructure/adapters/services/commentAnalysis.service';
import { CommentManagerService } from '../infrastructure/adapters/services/commentManager.service';
import {
    CROSS_FILE_ANALYSIS_SERVICE_TOKEN,
    CrossFileAnalysisService,
} from '../infrastructure/adapters/services/crossFileAnalysis.service';
import {
    LLM_ANALYSIS_SERVICE_TOKEN,
    LLMAnalysisService,
} from '../infrastructure/adapters/services/llmAnalysis.service';
import { MessageTemplateProcessor } from '../infrastructure/adapters/services/messageTemplateProcessor.service';
import { PullRequestHandlerService } from '../infrastructure/adapters/services/pullRequestManager.service';
import { SuggestionService } from '../infrastructure/adapters/services/suggestion.service';

import { OrganizationModule } from '@libs/organization/modules/organization.module';
import { OrganizationParametersModule } from '@libs/organization/modules/organizationParameters.module';
import { UserModule } from '@libs/identity/modules/user.module';

import { codeReviewPipelineProvider } from '@libs/core/providers/code-review-pipeline.provider.ee';
import { pipelineProvider } from '@libs/core/providers/pipeline.provider.ee';

import { GlobalCacheModule } from '@libs/core/cache/cache.module';
import { DryRunModule } from '@libs/dryRun/dry-run.module';
import { SafeguardPipelineService } from '../infrastructure/adapters/services/safeguardPipeline.service';
import { AstGraphModule } from './ast-graph.module';
import { DocumentationContextModule } from './documentation-context.module';

@Module({
    imports: [
        forwardRef(() => IntegrationCoreModule),
        forwardRef(() => IntegrationConfigCoreModule),
        forwardRef(() => ParametersModule),
        forwardRef(() => PlatformModule),
        forwardRef(() => TeamModule),
        forwardRef(() => KodyRulesModule),
        forwardRef(() => PullRequestsModule),
        forwardRef(() => SuggestionEmbeddedModule),
        forwardRef(() => CodeReviewFeedbackModule),
        forwardRef(() => FileReviewModule),
        forwardRef(() => CodeReviewPipelineModule),
        forwardRef(() => KodyFineTuningContextModule),
        forwardRef(() => GlobalParametersModule),
        forwardRef(() => TokenChunkingModule),
        forwardRef(() => LicenseModule),
        forwardRef(() => ContextReferenceModule),
        forwardRef(() => PermissionValidationModule),
        forwardRef(() => AIEngineModule),
        forwardRef(() => OrganizationParametersModule),
        forwardRef(() => OrganizationModule),
        forwardRef(() => UserModule),
        forwardRef(() => DryRunModule),
        forwardRef(() => DocumentationContextModule),
        AstGraphModule,
        GlobalCacheModule,
        SandboxModule,
    ],
    providers: [
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
            provide: KODY_RULES_PR_LEVEL_ANALYSIS_SERVICE_TOKEN,
            useClass: KodyRulesPrLevelAnalysisService,
        },
        {
            provide: COLLECT_CROSS_FILE_CONTEXTS_SERVICE_TOKEN,
            useClass: CollectCrossFileContextsService,
        },
        {
            provide: CODEBASE_SEARCH_SERVICE_TOKEN,
            useClass: CodebaseSearchService,
        },
        {
            provide: CROSS_FILE_ANALYSIS_SERVICE_TOKEN,
            useClass: CrossFileAnalysisService,
        },
        {
            provide: SUGGESTION_SERVICE_TOKEN,
            useClass: SuggestionService,
        },
        CodeAnalysisOrchestrator,
        CodeReviewHandlerService,
        KodyFineTuningService,
        CommentAnalysisService,
        MessageTemplateProcessor,
        pipelineProvider,
        codeReviewPipelineProvider,
        SafeguardPipelineService,
    ],
    exports: [
        PULL_REQUEST_MANAGER_SERVICE_TOKEN,
        LLM_ANALYSIS_SERVICE_TOKEN,
        COMMENT_MANAGER_SERVICE_TOKEN,
        CODE_BASE_CONFIG_SERVICE_TOKEN,
        KODY_RULES_ANALYSIS_SERVICE_TOKEN,
        KODY_RULES_PR_LEVEL_ANALYSIS_SERVICE_TOKEN,
        COLLECT_CROSS_FILE_CONTEXTS_SERVICE_TOKEN,
        CROSS_FILE_ANALYSIS_SERVICE_TOKEN,
        SUGGESTION_SERVICE_TOKEN,
        SandboxModule,
        CodeAnalysisOrchestrator,
        KodyFineTuningService,
        CodeReviewHandlerService,
        CommentAnalysisService,
        MessageTemplateProcessor,
        pipelineProvider,
        SafeguardPipelineService,
        AstGraphModule,
    ],
})
export class CodebaseModule {}
