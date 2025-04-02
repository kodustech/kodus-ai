import {
    AIAnalysisResult,
    AnalysisContext,
    CodeAnalysisAST,
    ReviewModeResponse,
} from '@/config/types/general/codeReview.type';
import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';

import { FunctionsAffectResult, FunctionSimilarity } from '@/ee/codeBase/ast/services/code-analyzer.service';
import { ChangeResult } from '@/ee/codeBase/diffAnalyzer.service';

export const AST_ANALYSIS_SERVICE_TOKEN = Symbol('ASTAnalysisService');

export interface IASTAnalysisService {
    analyzeASTWithAI(
        context: AnalysisContext,
        reviewModeResponse: ReviewModeResponse,
    ): Promise<AIAnalysisResult>;
    cloneAndGenerate(
        repository: any,
        pullRequest: any,
        platformType: string,
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<CodeAnalysisAST>;
    generateImpactAnalysis(
        codeAnalysis: CodeAnalysisAST,
        functionsAffected: ChangeResult,
        pullRequest: any,
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<{
        functionsAffectResult: FunctionsAffectResult[];
        functionSimilarity: FunctionSimilarity[];
    }>;
    analyzeCodeWithGraph(
        codeChunk: string,
        fileName: string,
        organizationAndTeamData: OrganizationAndTeamData,
        pullRequest: any,
        codeAnalysisAST: CodeAnalysisAST,
    ): Promise<ChangeResult>;
}
