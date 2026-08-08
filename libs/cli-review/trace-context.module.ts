import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PlatformModule } from '@libs/platform/modules/platform.module';
import { BuildTraceContextPackUseCase } from './application/use-cases/build-trace-context-pack.use-case';
import { PostTracePrCommentUseCase } from './application/use-cases/post-trace-pr-comment.use-case';
import { SessionEventRepository } from './infrastructure/repositories/session-event.repository';
import { SessionEventModel } from './infrastructure/repositories/schemas/session-event.model';

/**
 * The read side of Kodus Trace, split out of `CliReviewModule` so the code
 * review pipeline can consume recorded decisions without importing the whole
 * CLI review surface (and without the module cycle that would create).
 */
@Module({
    imports: [
        TypeOrmModule.forFeature([SessionEventModel]),
        forwardRef(() => PlatformModule),
    ],
    providers: [
        SessionEventRepository,
        BuildTraceContextPackUseCase,
        PostTracePrCommentUseCase,
    ],
    exports: [BuildTraceContextPackUseCase, PostTracePrCommentUseCase],
})
export class TraceContextModule {}
