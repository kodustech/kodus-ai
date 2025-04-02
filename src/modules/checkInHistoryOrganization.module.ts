import { CHECKIN_HISTORY_ORGANIZATION_SERVICE_TOKEN } from '@/core/domain/checkinHistoryOrganization/contracts/checkinHistory.service.contracts';
import { CHECKIN_HISTORY_ORGANIZATION_REPOSITORY_TOKEN } from '@/core/domain/checkinHistoryOrganization/contracts/checkinHistoryOrganization.repository';
import { CheckinHistoryOrganizationDatabaseRepository } from '@/core/infrastructure/adapters/repositories/mongoose/checkinHistoryOrganization.repository';
import { CheckinHistoryOrganizationModelInstance } from '@/core/infrastructure/adapters/repositories/mongoose/schema';
import { CheckinHistoryOrganizationService } from '@/core/infrastructure/adapters/services/checkinHistoryOrganization.service';
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

@Module({
    imports: [MongooseModule.forFeature([CheckinHistoryOrganizationModelInstance])],
    providers: [
        {
            provide: CHECKIN_HISTORY_ORGANIZATION_SERVICE_TOKEN,
            useClass: CheckinHistoryOrganizationService,
        },
        {
            provide: CHECKIN_HISTORY_ORGANIZATION_REPOSITORY_TOKEN,
            useClass: CheckinHistoryOrganizationDatabaseRepository,
        },
    ],
    exports: [CHECKIN_HISTORY_ORGANIZATION_SERVICE_TOKEN, CHECKIN_HISTORY_ORGANIZATION_REPOSITORY_TOKEN],
})
export class CheckinHistoryOrganizationModule { }
