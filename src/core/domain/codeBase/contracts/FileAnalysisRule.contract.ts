/**
 * @license
 * Kodus Tech. All rights reserved.
 */
import { FileChange } from '@/config/types/general/codeReview.type';
import { AnalysisContext } from '@/config/types/general/codeReview.type';
import { CodeSuggestion } from '@/config/types/general/codeReview.type';
import { IClusterizedSuggestion } from '@/ee/kodyFineTuning/domain/interfaces/kodyFineTuning.interface';

export interface IFileAnalysisRule {
    /**
     * Verifica se a regra está habilitada para o contexto atual
     */
    isEnabled(context: AnalysisContext): boolean;

    /**
     * Executa a análise de arquivos de acordo com a regra
     */
    analyzeFiles(
        files: FileChange[],
        context: AnalysisContext,
        suggestions: CodeSuggestion[],
        clusterizedSuggestions: IClusterizedSuggestion[],
    ): Promise<{
        validSuggestions: CodeSuggestion[];
        discardedSuggestions: CodeSuggestion[];
        overallComments: { filepath: string; summary: string }[];
    }>;
}
