/**
 * @license
 * Kodus Tech. All rights reserved.
 */

import { forwardRef, Module } from '@nestjs/common';

import { CodebaseModule } from '@/modules/codeBase.module';
import { KODY_AST_ANALYZE_CONTEXT_PREPARATION_PROVIDER } from '@/core/infrastructure/providers/kody-ast-analyze-context-preparation.provider.ee';
import { KODY_AST_ANALYZE_CONTEXT_PREPARATION_TOKEN } from '@/shared/interfaces/kody-ast-analyze-context-preparation.interface';
import { KodyASTAnalyzeContextPreparationService } from '@/core/infrastructure/adapters/services/kodyASTAnalyze/kody-ast-analyze-context-preparation.service';
import { LogModule } from '@/modules/log.module';

@Module({
    imports: [forwardRef(() => CodebaseModule), LogModule],
    providers: [
        KodyASTAnalyzeContextPreparationService, // Core implementation
        KODY_AST_ANALYZE_CONTEXT_PREPARATION_PROVIDER,
    ],
    exports: [
        KODY_AST_ANALYZE_CONTEXT_PREPARATION_TOKEN,
        KodyASTAnalyzeContextPreparationService,
    ],
})
export class KodyASTAnalyzeContextModule {}
