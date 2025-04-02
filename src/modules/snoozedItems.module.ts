import { UseCases } from '@/core/application/use-cases/snoozedItems';
import { SNOOZED_ITEMS_REPOSITORY_TOKEN } from '@/core/domain/snoozedItems/contracts/snoozedItems.repository';
import { SNOOZED_ITEMS_SERVICE_TOKEN } from '@/core/domain/snoozedItems/contracts/snoozedItems.service.contracts';
import { SnoozedItemsModelInstance } from '@/core/infrastructure/adapters/repositories/mongoose/schema';
import { SnoozedItemsDatabaseRepository } from '@/core/infrastructure/adapters/repositories/mongoose/snoozedItems.repository';
import { SnoozedItemsService } from '@/core/infrastructure/adapters/services/snoozedItems/snoozedItems.service';
import { SnoozedItemsController } from '@/core/infrastructure/http/controllers/snoozedItems.controllers';
import { forwardRef, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { TeamMembersModule } from './teamMembers.module';
import { CheckinHistoryModule } from './checkinHistory.module';

@Module({
    imports: [
        MongooseModule.forFeature([SnoozedItemsModelInstance]),
        forwardRef(() => TeamMembersModule),
        forwardRef(() => CheckinHistoryModule),
    ],
    providers: [
        ...UseCases,
        SnoozedItemsService,
        {
            provide: SNOOZED_ITEMS_SERVICE_TOKEN,
            useClass: SnoozedItemsService,
        },
        {
            provide: SNOOZED_ITEMS_REPOSITORY_TOKEN,
            useClass: SnoozedItemsDatabaseRepository,
        },
    ],
    controllers: [SnoozedItemsController],
    exports: [
        SNOOZED_ITEMS_SERVICE_TOKEN,
        SNOOZED_ITEMS_REPOSITORY_TOKEN,
    ],
})
export class SnoozedItemsModule {}
