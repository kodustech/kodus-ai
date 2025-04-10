/**
 * @license
 * Kodus Tech. All rights reserved.
 */

import { KodyASTAnalyzeContextPreparationService } from '../adapters/services/kodyASTAnalyze/kody-ast-analyze-context-preparation.service';
import { Provider } from '@nestjs/common';
import { PinoLoggerService } from '../adapters/services/logger/pino.service';
import {
    IKodyASTAnalyzeContextPreparationService,
    KODY_AST_ANALYZE_CONTEXT_PREPARATION_TOKEN,
} from '@/shared/interfaces/kody-ast-analyze-context-preparation.interface';
import { KodyASTAnalyzeContextPreparationServiceEE } from '@/ee/kodyASTAnalyze/kody-ast-analyze-context-preparation.ts';
import { CodeAnalysisOrchestrator } from '@/ee/codeBase/codeAnalysisOrchestrator.service';
import { environment } from '@/ee/configs/environment';

export const KODY_AST_ANALYZE_CONTEXT_PREPARATION_PROVIDER: Provider = {
    provide: KODY_AST_ANALYZE_CONTEXT_PREPARATION_TOKEN,
    useFactory: (
        corePreparation: KodyASTAnalyzeContextPreparationService,
        codeAnalysisOrchestrator: CodeAnalysisOrchestrator,
        pinoLoggerService: PinoLoggerService,
    ): IKodyASTAnalyzeContextPreparationService => {
        const isCloud = environment.API_CLOUD_MODE;

        if (isCloud) {
            return new KodyASTAnalyzeContextPreparationServiceEE(
                codeAnalysisOrchestrator,
                pinoLoggerService,
            );
        }

        return corePreparation;
    },
    inject: [
        KodyASTAnalyzeContextPreparationService,
        CodeAnalysisOrchestrator,
        PinoLoggerService,
    ],
};
