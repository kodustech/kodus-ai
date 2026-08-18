import { Module, forwardRef } from '@nestjs/common';
import { PlatformModule } from '@libs/platform/modules/platform.module';
import { BuildTraceContextPackUseCase } from './application/use-cases/build-trace-context-pack.use-case';
import { PostTracePrCommentUseCase } from './application/use-cases/post-trace-pr-comment.use-case';
import { TRACE_DECISION_BRANCH_READER_TOKEN } from './domain/contracts/trace-decision-branch-reader.contract';
import { TraceDecisionBranchReaderService } from './infrastructure/adapters/trace-decision-branch-reader.service';

/**
 * The read side of Kodus Trace, split out of `CliReviewModule` so the code
 * review pipeline can consume recorded decisions without importing the whole
 * CLI review surface (and without the module cycle that would create).
 */
@Module({
    imports: [forwardRef(() => PlatformModule)],
    providers: [
        TraceDecisionBranchReaderService,
        {
            provide: TRACE_DECISION_BRANCH_READER_TOKEN,
            useExisting: TraceDecisionBranchReaderService,
        },
        BuildTraceContextPackUseCase,
        PostTracePrCommentUseCase,
    ],
    exports: [BuildTraceContextPackUseCase, PostTracePrCommentUseCase],
})
export class TraceContextModule {}
