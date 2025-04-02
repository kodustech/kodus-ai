/**
 * @license
 * Kodus Tech. All rights reserved.
 */

import { AIAnalysisResult, AnalysisContext } from '@/config/types/general/codeReview.type';

export const KODY_AST_ANALYZE_CONTEXT_PREPARATION_TOKEN = Symbol(
    'KodyASTAnalyzeContextPreparation',
);

export interface IKodyASTAnalyzeContextPreparationService {
    prepareKodyASTAnalyzeContext(
        context: AnalysisContext,
    ): Promise<AIAnalysisResult | null>
}
