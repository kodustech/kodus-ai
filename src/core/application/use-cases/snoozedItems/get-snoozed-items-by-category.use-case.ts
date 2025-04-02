import {
    ISnoozedItemsService,
    SNOOZED_ITEMS_SERVICE_TOKEN,
} from '@/core/domain/snoozedItems/contracts/snoozedItems.service.contracts';
import { ModuleCategory } from '@/core/domain/snoozedItems/enums/module-category.enum';
import { PinoLoggerService } from '@/core/infrastructure/adapters/services/logger/pino.service';
import { IUseCase } from '@/shared/domain/interfaces/use-case.interface';
import { Inject, Injectable } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import * as moment from 'moment-timezone';

@Injectable()
export class GetSnoozedItemsByCategoryUseCase implements IUseCase {
    constructor(
        @Inject(SNOOZED_ITEMS_SERVICE_TOKEN)
        private readonly snoozedItemsService: ISnoozedItemsService,

        @Inject(REQUEST)
        private readonly request: Request & {
            user: { organization: { uuid: string }; uuid };
        },

        private logger: PinoLoggerService,
    ) {}

    async execute(params: {
        teamId?: string;
        organizationId: string;
        category: ModuleCategory;
        snoozedDate?: Date;
    }): Promise<Partial<any[]>> {
        try {
            params.organizationId =
                params.organizationId || this.request.user.organization.uuid;

            const snoozedItems =
                await this.snoozedItemsService.getByCategory(params);

            if (!snoozedItems?.length) {
                return null;
            }

            return snoozedItems.map((snoozedItem) => {
                return {
                    uuid: snoozedItem.uuid,
                    snoozeUntil: moment(snoozedItem.snoozeUntil).format(
                        'DD/MM/YYYY',
                    ),
                    snoozeStart: moment(snoozedItem.snoozeStart).format(
                        'DD/MM/YYYY',
                    ),
                    category: snoozedItem.category,
                    sectionType: snoozedItem.sectionType,
                    notificationLevel: snoozedItem.notificationLevel,
                    snoozeObject: snoozedItem.snoozeObject,
                    teamId: snoozedItem.teamId,
                    organizationId: snoozedItem.organizationId,
                    snoozedBy: snoozedItem.snoozedBy,
                };
            });
        } catch (error) {
            this.logger.error({
                message:
                    'Error while trying to fetch snoozed items by module category',
                context: GetSnoozedItemsByCategoryUseCase.name,
                serviceName: 'GetSnoozedItemsByModuleCategoryUseCase',
                error: error,
                metadata: {
                    teamId: params.teamId,
                    organizationId: params.organizationId,
                },
            });
        }
    }
}
