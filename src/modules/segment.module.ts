import { Module } from '@nestjs/common';
import { SegmentController } from '@/core/infrastructure/http/controllers/segment.controller';
import { UseCases } from '@/core/application/use-cases/segment';

@Module({
    controllers: [SegmentController],
    providers: [...UseCases],
    exports: [],
})
export class SegmentModule {}
