/**
 * @license
 * Kodus Tech. All rights reserved.
 */

import { forwardRef, Module } from '@nestjs/common';
import { PinoLoggerService } from '@/core/infrastructure/adapters/services/logger/pino.service';

import { CodebaseModule } from '@/modules/codeBase.module';
import { KODY_AST_ANALYZE_CONTEXT_PREPARATION_PROVIDER } from '@/core/infrastructure/providers/kody-ast-analyze-context-preparation.provider.ee';
import { KODY_AST_ANALYZE_CONTEXT_PREPARATION_TOKEN } from '@/shared/interfaces/kody-ast-analyze-context-preparation.interface';
import { KodyASTAnalyzeContextPreparationService } from '@/core/infrastructure/adapters/services/kodyASTAnalyze/kody-ast-analyze-context-preparation.service';

@Module({
    imports: [forwardRef(() => CodebaseModule)],
    providers: [
        KodyASTAnalyzeContextPreparationService, // Core implementation
        PinoLoggerService,
        KODY_AST_ANALYZE_CONTEXT_PREPARATION_PROVIDER,
    ],
    exports: [
        KODY_AST_ANALYZE_CONTEXT_PREPARATION_TOKEN,
        KodyASTAnalyzeContextPreparationService,
    ],
})
export class KodyASTAnalyzeContextModule { }
