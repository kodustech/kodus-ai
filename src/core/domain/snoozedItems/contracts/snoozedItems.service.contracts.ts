import { OrganizationAndTeamDataDto } from '@/core/infrastructure/http/dtos/organizationAndTeamData.dto';
import { CHECKIN_TYPE } from '../../checkinHistory/enums/checkin-type.enum';
import { SnoozedItemsEntity } from '../entities/snoozedItems.entity';
import { ModuleCategory } from '../enums/module-category.enum';
import { SectionType } from '../enums/section-type.enum';
import { ISnoozedItemsRepository } from './snoozedItems.repository';

export const SNOOZED_ITEMS_SERVICE_TOKEN = Symbol('SnoozedItemsService');

export interface ISnoozedItemsService extends ISnoozedItemsRepository {
    getByCategory(params: {
        teamId?: string;
        organizationId: string;
        category: ModuleCategory;
        snoozedDate?: Date;
    }): Promise<SnoozedItemsEntity[]>;
    getBySectionType(params: {
        teamId?: string;
        organizationId: string;
        sectionType: SectionType;
        snoozedDate?: Date;
    }): Promise<SnoozedItemsEntity[]>;
    getByTeamId(teamId: string): Promise<SnoozedItemsEntity[]>;
    getByOrganizationId(organizationId: string): Promise<SnoozedItemsEntity[]>;
    prepareDataToSave(
        params: any,
        organizationId: string,
    ): Promise<SnoozedItemsEntity>;
    removeFromNotification(
        sectionItems: any[],
        sectionId: string,
        snoozedItems: any[],
        keyProperty: string,
        checkinType: CHECKIN_TYPE,
        organizationAndTeamData: OrganizationAndTeamDataDto,
    )
}
