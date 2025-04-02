import { Injectable, Inject } from '@nestjs/common';
import {
    AST_ANALYSIS_SERVICE_TOKEN,
    IASTAnalysisService,
} from '@/core/domain/codeBase/contracts/ASTAnalysisService.contract';
import { BasePipelineStage } from '@/core/infrastructure/adapters/services/pipeline/base-stage.abstract';
import { CodeReviewPipelineContext } from '@/core/infrastructure/adapters/services/codeBase/codeReviewPipeline/context/code-review-pipeline.context';

const ENABLE_CODE_REVIEW_AST =
    process.env.API_ENABLE_CODE_REVIEW_AST === 'true';

@Injectable()
export class CodeAnalysisASTStage extends BasePipelineStage<CodeReviewPipelineContext> {
    stageName = 'CodeAnalysisASTStage';

    constructor(
        @Inject(AST_ANALYSIS_SERVICE_TOKEN)
        private readonly codeASTAnalysisService: IASTAnalysisService,
    ) {
        super();
    }

    protected async executeStage(
        context: CodeReviewPipelineContext,
    ): Promise<CodeReviewPipelineContext> {
        if (
            !ENABLE_CODE_REVIEW_AST ||
            !context.codeReviewConfig.reviewOptions?.breaking_changes
        ) {
            return context; // não executa se AST estiver desabilitado
        }

        const codeAnalysisAST =
            await this.codeASTAnalysisService.cloneAndGenerate(
                context.repository,
                context.pullRequest,
                context.platformType,
                context.organizationAndTeamData,
            );

        return this.updateContext(context, (draft) => {
            draft.codeAnalysisAST = codeAnalysisAST;
        });
    }
}
