import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { PrDecisionRecordModel } from '../infrastructure/adapters/repositories/schemas/prDecisionRecord.model';
import { PrDecisionRecordRepository } from '../infrastructure/adapters/repositories/prDecisionRecord.repository';

/** Module that exposes the per-PR reconciler's source-of-truth row. */
@Module({
    imports: [TypeOrmModule.forFeature([PrDecisionRecordModel])],
    providers: [PrDecisionRecordRepository],
    exports: [PrDecisionRecordRepository],
})
export class PrDecisionRecordModule {}
