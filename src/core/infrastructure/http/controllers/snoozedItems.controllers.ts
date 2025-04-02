import { Controller, Post, Body, Get, Query } from '@nestjs/common';

import { ModuleCategory } from '@/core/domain/snoozedItems/enums/module-category.enum';
import { SectionType } from '@/core/domain/snoozedItems/enums/section-type.enum';
import { CreateSnoozeItemUseCase } from '@/core/application/use-cases/snoozedItems/create-snooze-item.use-case';
import { GetSnoozedItemsByCategoryUseCase } from '@/core/application/use-cases/snoozedItems/get-snoozed-items-by-category.use-case';
import { SnoozeTime } from '@/core/domain/snoozedItems/enums/snooze-time.enum';
import { NotificationLevel } from '@/core/domain/snoozedItems/enums/notification-level.enum';

@Controller('snoozed-items')
export class SnoozedItemsController {
    constructor(
        private readonly createSnoozeItemUseCase: CreateSnoozeItemUseCase,
        private readonly getSnoozedItemsByModuleCategoryUseCase: GetSnoozedItemsByCategoryUseCase,
    ) {}

    @Post('/slack')
    public async snoozeItem(
        @Body()
        body: {
            category: ModuleCategory;
            sectionType: SectionType;
            notificationLevel?: NotificationLevel;
            snoozeTime: SnoozeTime;
            snoozeItemKey?: string;
            teamId: string;
            organizationId: string;
            slackUserId?: string;
        },
    ) {
        return this.createSnoozeItemUseCase.execute(body);
    }

    @Post('/web')
    public async snoozeItemWeb(
        @Body()
        body: {
            category: ModuleCategory;
            sectionType: SectionType;
            notificationLevel?: NotificationLevel;
            snoozeTime: SnoozeTime;
            snoozeObject: any;
            teamId: string;
            organizationId?: string;
        },
    ) {
        return this.createSnoozeItemUseCase.execute(body);
    }

    @Get('/')
    public async getSnoozedItemsByModuleCategory(
        @Query('teamId') teamId?: string,
        @Query('organizationId') organizationId?: string,
    ) {
        return this.getSnoozedItemsByModuleCategoryUseCase.execute({
            teamId,
            organizationId,
            category: ModuleCategory.CHECKIN,
        });
    }
}
