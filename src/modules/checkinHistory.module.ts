import { CHECKIN_HISTORY_REPOSITORY_TOKEN } from '@/core/domain/checkinHistory/contracts/checkinHistory.repository';
import { CHECKIN_HISTORY_SERVICE_TOKEN } from '@/core/domain/checkinHistory/contracts/checkinHistory.service.contracts';
import { CheckinHistoryDatabaseRepository } from '@/core/infrastructure/adapters/repositories/mongoose/checkinHistory.repository';
import { CheckinHistoryModelInstance } from '@/core/infrastructure/adapters/repositories/mongoose/schema';
import { CheckinHistoryService } from '@/core/infrastructure/adapters/services/checkinHistory.service';
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

@Module({
    imports: [MongooseModule.forFeature([CheckinHistoryModelInstance])],
    providers: [
        {
            provide: CHECKIN_HISTORY_SERVICE_TOKEN,
            useClass: CheckinHistoryService,
        },
        {
            provide: CHECKIN_HISTORY_REPOSITORY_TOKEN,
            useClass: CheckinHistoryDatabaseRepository,
        },
    ],
    exports: [CHECKIN_HISTORY_SERVICE_TOKEN, CHECKIN_HISTORY_REPOSITORY_TOKEN],
})
export class CheckinHistoryModule {}
